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
import { createTecAssuredClient } from "../_shared/tecassured.ts";
import { secretsMatch } from "../_shared/supabase.ts";

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
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function formatDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  }
  return null;
}

function mapCondition(condition: string | null): string {
  if (!condition) return "New";
  const lower = condition.toLowerCase();
  if (lower === "used" || lower === "pre-owned") return "Used";
  return "New";
}

function mapFinanceType(financeType: string | null): string | null {
  if (!financeType) return null;
  const lower = financeType.toLowerCase();
  if (lower === "loan") return "Purchase";
  if (lower === "lease") return "Lease";
  if (lower === "cash") return "Cash";
  return null;
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
        "unit_make", "unit_model", "sale_date",
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

    // ── Step 4: Validate required fields ───────────────────────────────
    const missing: string[] = [];
    if (!sess.vin) missing.push("vin");
    if (!sess.vehicle_type_code) missing.push("vehicle_type_code");
    if (sess.sale_price === null || sess.sale_price === undefined) missing.push("sale_price");
    if (sess.odometer === null || sess.odometer === undefined) missing.push("odometer");
    if (!sess.condition) missing.push("condition");
    if (!sess.sale_date) missing.push("sale_date");

    if (missing.length > 0) {
      return json(400, {
        error: "Missing required fields for rating",
        missing_fields: missing,
        message: `The following fields are required before rating: ${missing.join(", ")}. Use the overrides parameter to provide them.`,
      });
    }

    // ── Step 5: Build the rate request ─────────────────────────────────
    const today = new Date().toISOString().split("T")[0];
    const saleDate = formatDate(sess.sale_date) ?? today;
    const inServiceDate = formatDate(sess.in_service_date) ?? saleDate;
    const purchaseType = mapCondition(sess.condition);

    const ratePayload: Record<string, unknown> = {
      dealerCode,
      vtype: sess.vehicle_type_code,
      vin: sess.vin,
      // NOTE: vehiclePrice is the vehicle selling price (Sold_1_Vehicle_DSP).
      // TecAssured may want the total amount financed before F&I products for
      // some calculations like GAP. Revisit once live rate responses confirm it.
      vehiclePrice: String(sess.sale_price),
      odometer: String(sess.odometer),
      purchaseType,
      vehicleStatus: purchaseType,
      rateDate: today,
      saleDate,
      vehiclePurchaseDate: saleDate,
      inServiceDate,
      productType: "All",
    };

    if (sess.unit_year) ratePayload.year = String(sess.unit_year);
    if (sess.unit_make) ratePayload.make = sess.unit_make;
    if (sess.unit_model) ratePayload.model = sess.unit_model;
    if (sess.amount_financed) ratePayload.financeAmount = String(sess.amount_financed);
    if (sess.finance_term) ratePayload.financeTerm = String(sess.finance_term);
    if (sess.apr) ratePayload.financeApr = String(sess.apr);

    const financeType = mapFinanceType(sess.finance_type);
    if (financeType) ratePayload.financeType = financeType;

    if (sess.buyer_city) ratePayload.customerCity = sess.buyer_city;
    if (sess.buyer_state) ratePayload.customerState = sess.buyer_state;
    if (sess.buyer_zip) ratePayload.customerPostalCode = sess.buyer_zip;

    const properties: { name: string; value: string }[] = [];
    if (sess.sale_price) properties.push({ name: "msrp", value: String(sess.sale_price) });
    if (properties.length > 0) ratePayload.properties = properties;

    // ── Step 6: Rate ───────────────────────────────────────────────────
    const offerResponse = await client.rateVehicle(ratePayload);

    let productCount = 0;
    if (offerResponse && typeof offerResponse === "object") {
      const offer = offerResponse as Record<string, unknown>;
      if (Array.isArray(offer.products)) productCount = offer.products.length;
      else if (Array.isArray(offer.productTypes)) productCount = offer.productTypes.length;
    }

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
