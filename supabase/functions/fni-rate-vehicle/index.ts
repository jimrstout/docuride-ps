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
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createTecAssuredClient, EndpointNotFoundError } from "../_shared/tecassured.ts";
import { secretsMatch } from "../_shared/supabase.ts";
import { allTiers, normalizeOffer } from "../_shared/planner-offers.ts";
import {
  parseRequiredProperties,
  readRateProperties,
  writeRateProperties,
  type RequiredProperty,
} from "../_shared/rate-properties.ts";
import { buildRateRequest, type RateSource } from "../_shared/rate-request.ts";
import { applyStaffEdits, parseStaffEdits } from "../_shared/staff-edits.ts";

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

// ─── Recording what happened ─────────────────────────────────────────────
//
// Every exit from the rating attempt below writes a row, not just the happy one.
// Before this, fni.rated_offers held only successful quotes, so its absence had
// to stand for three different things at once -- never asked, asked and failed,
// asked and genuinely offered nothing -- and the planner resolved that ambiguity
// by telling the customer plans were not offered. On deal 14132 that was simply
// untrue: a correctly mapped Can-Am Defender that nobody had asked about.
//
// So the row is the record of the last ATTEMPT. `state` says which of the three
// outcomes it was and `error_detail` says why, for staff. See migration 0013.

type AttemptState = "Rated" | "Not Offered" | "Failed";

async function recordAttempt(
  supabase: SupabaseClient,
  sessionId: string,
  state: AttemptState,
  fields: {
    request?: unknown;
    response?: unknown;
    productCount?: number;
    error?: string;
  } = {}
): Promise<void> {
  const { error } = await supabase
    .schema("fni")
    .from("rated_offers")
    .upsert(
      {
        session_id: sessionId,
        state,
        request_payload: fields.request ?? null,
        response_payload: fields.response ?? null,
        product_count: fields.productCount ?? 0,
        // The constraint in 0013 requires a reason for Failed and forbids one
        // otherwise, so this is normalised here rather than at each call site.
        error_detail: state === "Failed" ? (fields.error ?? "Rating failed") : null,
        rated_at: new Date().toISOString(),
      },
      { onConflict: "session_id" }
    );

  // A failure to record a failure must not become the thing the caller sees, so
  // it is logged and swallowed. The caller is already returning an error.
  if (error) {
    console.error(
      `RATE_ATTEMPT_NOT_RECORDED session=${sessionId} state=${state}: ${error.message}`
    );
  }
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

    // ── Step 2: The staff layer ────────────────────────────────────────
    //
    // Corrections made on the Verify screen, applied over the CRM's figures. This
    // is the whole reason those fields were made editable: a price the person at
    // the desk corrected has to be the price the provider is asked about, in BOTH
    // halves of the request. The properties array reads overrides out of
    // vehicle_properties already, but the documented top-level fields --
    // vehiclePrice, financeAmount, odometer -- come straight off the columns, so
    // substituting here is what keeps the two halves from describing two
    // different machines.
    //
    // In memory only. The columns keep the CRM's record; see migration 0016.
    const staffEdits = parseStaffEdits(
      (sess as unknown as Record<string, unknown>).staff_edits
    );
    const rateSource = applyStaffEdits(sess as unknown as Record<string, unknown>, staffEdits);

    // ── Step 2b: The overrides parameter ───────────────────────────────
    //
    // Predates the Verify screen and no caller sends it today: the console and
    // the planner both post session_id alone. It used to WRITE its values into
    // the session's columns, which is now exactly the thing the design forbids,
    // because it destroys the CRM figure that "differs from the CRM deal" has to
    // be measured against. So it stays as a way to rate a one-off what-if, and
    // it no longer persists anything.
    if (overrides && Object.keys(overrides).length > 0) {
      const allowedOverrides = [
        "vehicle_type_code", "unit_submodel", "odometer", "condition",
        "sale_price", "amount_financed", "apr", "finance_term",
        // The three finance columns _shared/finance-basis.ts actually reads.
        // finance_term_total and interest_rate are PREFERRED over finance_term and
        // apr, so without them an override of the older pair is silently shadowed:
        // the caller sets 48 months and the request still goes out with whatever
        // finance_term_total holds. tila_amount_financed does not reach the
        // request today -- financeAmount comes from amount_financed -- but it
        // decides which branch of the resolver answers, and a caller correcting a
        // deal's finance figures by hand should be able to set it.
        "finance_term_total", "interest_rate", "tila_amount_financed",
        "finance_type", "in_service_date", "vin", "unit_year",
        "unit_make", "unit_model", "sale_date", "vehicle_properties",
      ];

      for (const key of allowedOverrides) {
        if (key in overrides) rateSource[key] = overrides[key];
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
    const editedVtype = rateSource.vehicle_type_code as string | null;

    if (!editedVtype) {
      // A body type DocuRide cannot map to a TecAssured vehicle type. Not the
      // customer's business and not "not offered": it is a gap in our mapping
      // or a blank Sold_1_Body_Type on the deal, and a person has to close it.
      await recordAttempt(supabase, session_id, "Failed", {
        error:
          "No TecAssured vehicle type for this unit. The deal's body type is " +
          "either blank or not in BODY_TYPE_MAP (_shared/vehicle-types.ts), so " +
          "there is nothing to ask the provider about.",
      });
      return json(400, {
        error: "Missing required fields for rating",
        missing_fields: ["vehicle_type_code"],
        message:
          "The vehicle type decides which properties TecAssured needs, so it has " +
          "to be set before rating. Set it on the Verify screen.",
      });
    }

    const vtype = editedVtype;
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
      const detail =
        err instanceof EndpointNotFoundError
          ? `TecAssured's ${err.url} is not answering, so the properties needed to ` +
            `rate a ${vtype} cannot be determined.`
          : `Could not determine what TecAssured needs to rate a ${vtype}: ` +
            (err instanceof Error ? err.message : String(err));

      await recordAttempt(supabase, session_id, "Failed", { error: detail });
      return json(502, { error: detail });
    }

    if (required.length === 0) {
      // The dealer answered and had nothing. Not a fault: this Dealer ID does
      // not sell this vehicle type, which is the one case where "plans are not
      // offered on this machine" is a true thing to tell a customer.
      await recordAttempt(supabase, session_id, "Not Offered", {
        response: { requiredproperties: [], vtype, dealer_code: dealerCode },
      });
      return json(400, {
        error: `Dealer ID ${dealerCode} has no rateable products for vehicle type ${vtype}.`,
        vtype,
        dealer_code: dealerCode,
        status: "Unavailable",
      });
    }

    // ── Step 5: Answer exactly what was asked ────────────────────────────────
    const built = buildRateRequest(required, rateSource as unknown as RateSource, {
      dealerCode,
      vtype,
    });

    // ── An unanswered property no longer stops the request ────────────────
    //
    // It used to. Anything /rate/requiredproperties named and we could not fill
    // in was refused here, locally, and TecAssured was never asked -- on the
    // reasoning that a rate built from a partial request is a rate for a
    // different vehicle.
    //
    // That reasoning was right about price-bearing fields and wrong about who
    // gets to decide which fields those are. /rate/requiredproperties returns a
    // flat list of names, types and descriptions with no "required" flag on any
    // of them, so treating all seventeen as mandatory was our inference, not the
    // provider's instruction. And the provider is perfectly willing to say when
    // something it needs is absent: `{"error":" Missing displacement."}` is a
    // real response. A quote it returns for the inputs it was given is its own
    // price for its own inputs, which is more authoritative than our guess at
    // which inputs mattered.
    //
    // So we send what we have and let TecAssured rule. What we could not supply
    // is carried forward, because if it does refuse, this list is almost
    // certainly the reason and it is what a staff member needs to see.
    const unsupplied = built.missing.map((m) => m.description ?? m.name).join(", ");
    if (built.missing.length > 0) {
      console.warn(
        `RATE_PROPERTIES_UNSUPPLIED session=${session_id} vtype=${vtype} ` +
          `names=${JSON.stringify(built.missing.map((m) => m.name))}`
      );
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
        // The provider's own words first, then what we know we left out, since
        // that is nearly always the cause and the two together are the whole
        // answer to "why didn't this rate".
        await recordAttempt(supabase, session_id, "Failed", {
          request: ratePayload,
          response: offerResponse,
          error:
            `TecAssured refused the rate request: ${err.trim()}` +
            (unsupplied === ""
              ? ""
              : ` The deal does not carry ${unsupplied}; enter ${built.missing
                  .map((m) => m.name)
                  .join(", ")} on the session (vehicle_properties) and rate again.`),
        });
        return json(400, {
          error: `TecAssured could not rate this vehicle: ${err.trim()}`,
          tecassured_error: err.trim(),
          dealer_code: dealerCode,
          unsupplied_properties: built.missing.map((m) => m.name),
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
    // Zero products from a request the provider accepted is the honest "not
    // offered": it asked for nothing more and returned nothing. Anything else
    // that produced no products came back as an error above.
    await recordAttempt(supabase, session_id, productCount > 0 ? "Rated" : "Not Offered", {
      request: ratePayload,
      response: offerResponse,
      productCount,
    });

    // ── Step 8: Record status, the login and the Dealer ID that acted ──
    // The session only advances to Rated when there is something to present.
    // A "Not Offered" session has been asked about and has no menu, which is
    // not the same as being ready to present one.
    const { error: statusErr } = await supabase
      .schema("fni")
      .from("sessions")
      .update({
        status: productCount > 0 ? "Rated" : sess.status,
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
      status: productCount > 0 ? "Rated" : "Not Offered",
      product_count: productCount,
      dealer_code: dealerCode,
      environment: credentials.environment,
      offer: offerResponse,
      rated_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-rate-vehicle error:", message);

    // A timeout, a dropped connection, a malformed response. Recorded so the
    // planner shows neutral copy rather than inferring "not offered" from the
    // absence of a quote.
    await recordAttempt(supabase, session_id, "Failed", {
      error: `Rating failed: ${message}`,
    });

    return json(500, { error: message });
  }
});
