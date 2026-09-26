// fni-rate-vehicle/index.ts
// Called from the planner's server layer to rate a vehicle through TecAssured
// and get the Offer Format back.
//
// Input (POST JSON):
//   session_id  - fni.sessions UUID (required)
//   overrides   - optional field corrections from the UI
//
// Auth: FNI_WEBHOOK_SECRET via ?secret= query param or x-webhook-secret header
//
// ── The request is built from what the server asks for (2026-09-25) ───
// The rate request is NOT a set of named camelCase fields. TecAssured wants a
// `properties` array whose names come from /rate/requiredproperties for this
// dealer and this vehicle type -- dotted and lowercase: engine.ccs,
// finance.amount, sale.date, postal.code. Sending the camelCase fields makes
// the server ask for displacement even when displacement is supplied; sending
// the dotted names gets past that check.
//
// So this function asks what is needed, then sends BOTH halves: the documented
// top-level fields, and a properties array with one entry per name
// requiredproperties asked for, in its order, spelled its way. Proved against
// the QA server on 2026-09-25 -- 11 products, 41 rates. Sending either half
// alone fails. See _shared/rate-properties.ts for why the two formats are
// near-duplicates of each other.
//
// The spelling in the array matters and has no rule to it: `warranty` for ATV
// and MCYC, `Warranty` for UTV and BIKE, and not asked for at all by BOAT,
// PWAC or SNOW. Echoing their name back keeps that from becoming a list of
// exceptions here.
//
// A property requiredproperties asked for that we cannot supply stops the
// request rather than being omitted: a rate built from a partial request is a
// rate for a different vehicle.
//
// ── One login, many dealers (2026-09-25) ────────────────────────────────
// The dealer code used to come off the credential row, because a credential was
// a store. It now comes from the store's mapping in
// fni.store_provider_accounts, resolved through createTecAssuredClient(store),
// and the code actually sent is written to sessions.dealer_code_used.
//
// That last part is the point of recording it at all. Under one shared login
// the credential no longer identifies the dealer, and a mapping repointed at a
// new Dealer ID months from now must not be able to change what an existing
// contract says it was rated under. So the value is copied into the session at
// the moment it is sent, not joined back through the mapping later.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createTecAssuredClient, EndpointNotFoundError } from "../_shared/tecassured.ts";
import { secretsMatch } from "../_shared/supabase.ts";
import { allTiers, normalizeOffer } from "../_shared/planner-offers.ts";
import {
  buildRateRequest,
  parseRequiredProperties,
  readRateProperties,
  writeRateProperties,
  type RateSource,
  type RequiredProperty,
} from "../_shared/rate-properties.ts";

// ─── Types ───────────────────────────────────────────────────────────────

interface RateRequest {
  session_id: string;
  overrides?: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  credential_id: string | null;
  store_id: string;
  status: string;
  deal_number: string | null;
  stock_number: string | null;
  vin: string | null;
  unit_year: number | null;
  unit_make: string | null;
  unit_model: string | null;
  unit_submodel: string | null;
  condition: string | null;
  vehicle_type_code: string | null;
  odometer: number | null;
  sale_price: number | null;
  amount_financed: number | null;
  apr: number | null;
  finance_term: number | null;
  payment: number | null;
  finance_type: string | null;
  sale_date: string | null;
  in_service_date: string | null;
  buyer_city: string | null;
  buyer_state: string | null;
  buyer_zip: string | null;
  vehicle_properties: Record<string, unknown> | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Main handler ────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = new URL(req.url);

  const presented =
    url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
  if (!secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }

  let body: RateRequest;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { session_id, overrides } = body;
  if (!session_id) return json(400, { error: "session_id is required" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // ── Step 1: Load session ───────────────────────────────────────────
    const { data: session, error: sessErr } = await supabase
      .schema("fni")
      .from("sessions")
      .select("*")
      .eq("id", session_id)
      .single();

    if (sessErr || !session) return json(404, { error: `Session ${session_id} not found` });

    const sess = session as SessionRow;

    const terminalStatuses = ["Finalized", "Written Back", "Cancelled"];
    if (terminalStatuses.includes(sess.status)) {
      return json(400, { error: `Session is ${sess.status} and cannot be re-rated` });
    }

    // ── Step 2: Apply overrides ────────────────────────────────────────
    if (overrides && Object.keys(overrides).length > 0) {
      const allowedOverrides = [
        "vehicle_type_code", "unit_submodel", "odometer", "condition",
        "sale_price", "amount_financed", "apr", "finance_term",
        "finance_type", "in_service_date", "vin", "unit_year",
        "unit_make", "unit_model", "sale_date", "vehicle_properties",
      ];

      const patch: Record<string, unknown> = {};
      for (const key of allowedOverrides) {
        if (key in overrides) {
          patch[key] = overrides[key];
          (sess as unknown as Record<string, unknown>)[key] = overrides[key];
        }
      }

      if (Object.keys(patch).length > 0) {
        const { error: updateErr } = await supabase
          .schema("fni")
          .from("sessions")
          .update(patch)
          .eq("id", session_id);

        if (updateErr) console.error(`Failed to apply overrides: ${updateErr.message}`);
      }
    }

    // ── Step 3: Resolve the store's login and Dealer ID ────────────────
    //
    // By store, not by the session's credential_id. The mapping is the current
    // truth about which account and which Dealer ID this store uses, and a
    // session created before a store was configured should start working the
    // moment it is, without anyone editing the session row.
    let store;
    try {
      store = await createTecAssuredClient(sess.store_id, supabase);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }

    const { client, credentials, dealerCode } = store;

    // ── Step 4: What does this dealer need for this vehicle type? ────────────
    //
    // Cached overnight by fni-refresh-rate-properties. Fetched live when the
    // cache is cold or last said Unavailable, so a store configured this
    // morning still rates today, and a dealer since given the product is not
    // refused on a stale answer.
    if (!sess.vehicle_type_code) {
      return json(400, {
        error: "Missing required fields for rating",
        missing_fields: ["vehicle_type_code"],
        message:
          "The vehicle type decides which properties TecAssured needs, so it has " +
          "to be set before rating. Use the overrides parameter.",
      });
    }

    const vtype = sess.vehicle_type_code;
    let required: RequiredProperty[];

    try {
      const cached = await readRateProperties(supabase, store.account.id, vtype);

      if (cached && cached.status === "Cached") {
        required = parseRequiredProperties(cached.properties).properties;
      } else {
        const live = await client.getRequiredProperties(vtype);
        required = (await writeRateProperties(supabase, store.account.id, vtype, live)).properties;
      }
    } catch (err) {
      if (err instanceof EndpointNotFoundError) {
        return json(502, {
          error:
            `TecAssured's ${err.url} is not answering, so the properties needed to ` +
            `rate a ${vtype} cannot be determined.`,
        });
      }
      return json(502, {
        error:
          `Could not determine what TecAssured needs to rate a ${vtype}: ` +
          (err instanceof Error ? err.message : String(err)),
      });
    }

    if (required.length === 0) {
      // The dealer answered and had nothing. Not a fault: this Dealer ID does
      // not sell this vehicle type.
      return json(400, {
        error: `Dealer ID ${dealerCode} has no rateable products for vehicle type ${vtype}.`,
        vtype,
        dealer_code: dealerCode,
        status: "Unavailable",
      });
    }

    // ── Step 5: Answer exactly what was asked ────────────────────────────────
    const built = buildRateRequest(required, sess as unknown as RateSource, {
      dealerCode,
      vtype,
    });

    if (built.missing.length > 0) {
      // Reported with TecAssured's own description, because that is what tells
      // an F&I user what to type. engine.ccs, fuel.type and warranty have no
      // Zoho field behind them and are supplied via vehicle_properties.
      return json(400, {
        error: "Missing required fields for rating",
        vtype,
        missing_fields: built.missing.map((m) => m.name),
        missing_detail: built.missing.map((m) => ({
          name: m.name,
          description: m.description ?? null,
          type: m.type ?? null,
        })),
        message:
          `TecAssured requires ${built.missing.map((m) => m.description ?? m.name).join(", ")} ` +
          `to rate a ${vtype}. Supply them through overrides.vehicle_properties, keyed ` +
          `by the property name.`,
      });
    }

    const ratePayload = built.request;

    // ── Step 6: Rate ─────────────────────────────────────────────────────────
    const offerResponse = await client.rateVehicle(ratePayload);

    // ── A refusal is not an offer ──────────────────────────────────────
    // TecAssured answers a rejected request with HTTP 200 and an error string
    // -- {"error":" Missing displacement."} is a real one. Without this check
    // that object was written to rated_offers as the offer and the session was
    // marked "Rated", so the planner would have shown a customer a menu built
    // from an error message. The session deliberately keeps its current status.
    if (offerResponse && typeof offerResponse === "object") {
      const err = (offerResponse as Record<string, unknown>).error;
      if (typeof err === "string" && err.trim() !== "") {
        return json(400, {
          error: `TecAssured could not rate this vehicle: ${err.trim()}`,
          tecassured_error: err.trim(),
          dealer_code: dealerCode,
          // Echoed so the fix is visible without re-deriving the request.
          request: ratePayload,
        });
      }
    }

    // Counted through the normalizer, which is the one place that knows where
    // a real quote keeps its products: quote.vehicles[].products[]. This used
    // to look for a top-level `products` array, which the QA server has never
    // sent, so product_count was 0 on every live rating and the planner was
    // told an eleven-product quote held none.
    const productCount = allTiers(normalizeOffer(offerResponse)).length;

    // ── Step 7: Store the offer ────────────────────────────────────────
    const { error: offerErr } = await supabase
      .schema("fni")
      .from("rated_offers")
      .upsert(
        {
          session_id,
          request_payload: ratePayload,
          response_payload: offerResponse,
          product_count: productCount,
          rated_at: new Date().toISOString(),
        },
        { onConflict: "session_id" }
      );

    if (offerErr) {
      console.error(`Failed to store rated offer: ${offerErr.message}`);
      // The response is still good; do not fail the request over the cache.
    }

    // ── Step 8: Record status, the login and the Dealer ID that acted ──
    const { error: statusErr } = await supabase
      .schema("fni")
      .from("sessions")
      .update({
        status: "Rated",
        // Both are copies on purpose. Together they are the answer to "who
        // rated this", and neither may drift when configuration changes.
        credential_id: credentials.id,
        dealer_code_used: dealerCode,
      })
      .eq("id", session_id);

    if (statusErr) console.error(`Failed to update session status: ${statusErr.message}`);

    // ── Step 9: Return the offer ───────────────────────────────────────
    return json(200, {
      session_id,
      status: "Rated",
      product_count: productCount,
      dealer_code: dealerCode,
      environment: credentials.environment,
      offer: offerResponse,
      rated_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-rate-vehicle error:", message);
    return json(500, { error: message });
  }
});
