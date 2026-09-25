// fni-session-start/index.ts
// Called by Deluge when an F&I user clicks the menu button on a Zoho DC deal.
//
// Input (POST JSON):
//   zoho_deal_id  - Zoho record ID (required)
//   initiated_by  - Name or email of the user who clicked (required)
//
// Auth: FNI_WEBHOOK_SECRET via ?secret= query param or x-webhook-secret header
//
// Process:
//   1. Pull the full Zoho record fresh via getRecord()
//   2. Look up the store (Store_Location -> stores)
//   3. Return any existing active session rather than creating a duplicate
//   4. Resolve the store's provider mapping -> which login, which Dealer ID
//   5. Map Zoho fields -> fni.sessions snapshot
//   6. Return session_id + menu_url + provider status
//
// Does NOT use zoho-sync or the deals table for data. This is an intentional,
// on-demand pull that captures PII (address, phone, email, lienholder) only in
// the fni session scope.
//
// ── One login, many dealers (2026-09-25) ────────────────────────────────
// Step 4 used to read fni.provider_credentials by store_id, because every store
// had its own login. It now reads fni.store_provider_accounts, which answers
// two questions where there used to be one: which account this store logs in
// with, and which Dealer ID it is on that account. The session records both, so
// a mapping edited months later cannot change what this deal was rated under.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getRecord, ZohoRecord } from "../_shared/zoho.ts";
import { secretsMatch } from "../_shared/supabase.ts";

// ─── Types ───────────────────────────────────────────────────────────────

interface SessionStartRequest {
  zoho_deal_id: string;
  initiated_by: string;
}

interface StoreRow {
  id: string;
  tenant_id: string;
  zoho_store_location: string | null;
}

// ─── Zoho Body Type -> TecAssured vehicle type code ──────────────────────
// Best-guess mapping. The actual available types come from getVehicleTypes per
// dealer, now cached on the store mapping. The UI lets the user correct this.

const BODY_TYPE_MAP: Record<string, string> = {
  "ATV Off Road": "ATV",
  "ATV": "ATV",
  "SxS": "UTV",
  "Street Motorcycle": "MCYC",
  "3 Wheel Motorcycle": "MCYC",
  "Motorcycle Off Road": "BIKE",
  "Motocross Off Road": "BIKE",
  "PWCs": "PWAC",
  "Power Boats": "BOAT",
  "Snowmobile": "SNOW",
  //
  // Not TecAssured-ratable (no mapping needed):
  // Boat Trailers, Trailer, Trailers, Trailer - Utility, Electric Bicycle,
  // Excavators, Commercial zero turns, Residential zero turns,
  // Residential tractors, Tractors
};

// ─── Field helpers ───────────────────────────────────────────────────────

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const name = (v as { name?: unknown }).name;
    return typeof name === "string" && name.trim() !== "" ? name : null;
  }
  return null;
}

function numeric(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[$,%\s]/g, ""));
    return isNaN(n) ? null : n;
  }
  return null;
}

function integer(v: unknown): number | null {
  const n = numeric(v);
  return n !== null ? Math.round(n) : null;
}

/** Parse "City, ST ZIP" into components. */
function parseCityStateZip(combined: unknown): {
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const s = text(combined);
  if (!s) return { city: null, state: null, zip: null };

  const match = s.match(/^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (match) return { city: match[1].trim(), state: match[2], zip: match[3] };

  const match2 = s.match(/^(.+?),\s*([A-Z]{2})$/);
  if (match2) return { city: match2[1].trim(), state: match2[2], zip: null };

  return { city: s, state: null, zip: null };
}

// ─── Zoho record -> session row ──────────────────────────────────────────

function mapSession(
  record: ZohoRecord,
  storeId: string,
  tenantId: string,
  dealId: string | null,
  credentialId: string | null,
  initiatedBy: string
): Record<string, unknown> {
  const lienholderParsed = parseCityStateZip(record.Lienholder_City_State_ZIP);
  const bodyType = text(record.Sold_1_Body_Type);
  const vehicleTypeCode = bodyType ? BODY_TYPE_MAP[bodyType] ?? null : null;
  const hasLienholder = !!text(record.Lienholder_Name);
  const financeType = hasLienholder ? "Loan" : "Cash";
  const saleDate = record.Sale_Date ?? null;

  return {
    credential_id: credentialId,
    deal_id: dealId,
    store_id: storeId,
    tenant_id: tenantId,
    zoho_deal_id: String(record.id),
    status: "Initiated",
    initiated_by: initiatedBy,

    // A session created from a real Zoho deal is never a test session. Stated
    // rather than defaulted, so the two paths that create sessions both say
    // which kind they are making.
    is_test: false,

    // Vehicle
    deal_number: text(record.Name),
    stock_number: text(record.Sold_1_Stock_Number),
    vin: text(record.Sold_1_VIN),
    unit_year: integer(record.Sold_1_Year),
    unit_make: text(record.Sold_1_Make),
    unit_model: text(record.Sold_1_Model),
    unit_submodel: null,
    condition: text(record.Sold_1_Condition) || null,
    vehicle_type_code: vehicleTypeCode,
    odometer: integer(record.Sold_1_Meter),

    // Financials
    sale_price: numeric(record.Sold_1_Vehicle_DSP),
    amount_financed: numeric(record.DC_Sold_1_Balance_Due),
    apr: numeric(record.TILA_APR),
    finance_term: integer(record.TILA_Pmt1_Count),
    payment: numeric(record.TILA_Pmt1_Amount),
    finance_type: financeType,
    sale_date: saleDate,
    in_service_date: saleDate,

    // Buyer
    buyer_type: text(record.Buyer_Type) || null,
    buyer_display_name: text(record.Buyer_Display_Name),
    buyer_first_name: text(record.Buyer_First_Name),
    buyer_last_name: text(record.Buyer_Last_Name),
    buyer_address: text(record.Buyer_Street_Address),
    buyer_city: text(record.Buyer_City),
    buyer_state: text(record.Buyer_State),
    buyer_zip: text(record.Buyer_ZIP),
    buyer_phone: text(record.Buyer_Phone),
    buyer_email: text(record.Email),

    // Co-Buyer
    cobuyer_type: text(record.Co_Buyer_Type) || null,
    cobuyer_display_name: text(record.Co_Buyer_Display_Name),
    cobuyer_first_name: text(record.Co_Buyer_First_Name),
    cobuyer_last_name: text(record.Co_Buyer_Last_Name),
    cobuyer_address: text(record.Co_Buyer_Street_Address),
    cobuyer_city: text(record.Co_Buyer_City),
    cobuyer_state: text(record.Co_Buyer_State),
    cobuyer_zip: text(record.Co_Buyer_ZIP),
    cobuyer_phone: text(record.Co_Buyer_Phone),
    cobuyer_email: text(record.Co_Buyer_Email),

    // Lienholder
    lienholder_name: text(record.Lienholder_Name),
    lienholder_address: text(record.Lienholder_Street),
    lienholder_city: lienholderParsed.city,
    lienholder_state: lienholderParsed.state,
    lienholder_zip: lienholderParsed.zip,
    lienholder_phone: text(record.Lienholder_Phone),

    raw_snapshot: record,
  };
}

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

  let body: SessionStartRequest;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { zoho_deal_id, initiated_by } = body;
  if (!zoho_deal_id || !initiated_by) {
    return json(400, { error: "zoho_deal_id and initiated_by are required" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // ── Step 1: Pull the Zoho record ───────────────────────────────────
    const record = await getRecord("DocuRide", zoho_deal_id);
    if (!record) return json(404, { error: `Zoho deal ${zoho_deal_id} not found` });

    // ── Step 2: Look up the store ──────────────────────────────────────
    const storeLocation = text(record.Store_Location);
    if (!storeLocation) {
      return json(400, { error: "Deal has no Store Location set in Zoho" });
    }

    const { data: store, error: storeErr } = await supabase
      .from("stores")
      .select("id, tenant_id, zoho_store_location")
      .eq("zoho_store_location", storeLocation)
      .single();

    if (storeErr || !store) {
      return json(400, { error: `No matching store for location "${storeLocation}"` });
    }

    const storeRow = store as StoreRow;

    // ── Step 3: Existing active session wins ───────────────────────────
    const terminalStatuses = ["Finalized", "Written Back", "Cancelled"];
    const { data: existingSession } = await supabase
      .schema("fni")
      .from("sessions")
      .select("id, status, created_at")
      .eq("zoho_deal_id", zoho_deal_id)
      .not("status", "in", `(${terminalStatuses.join(",")})`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const menuBaseUrl = Deno.env.get("FNI_MENU_BASE_URL") ?? "https://docuride.app/fni";

    if (existingSession) {
      return json(200, {
        session_id: existingSession.id,
        status: existingSession.status,
        menu_url: `${menuBaseUrl}/${existingSession.id}`,
        existing: true,
        message: `Active session already exists (${existingSession.status})`,
      });
    }

    // ── Step 4: public.deals linkage, when there is one ────────────────
    const { data: dealRow } = await supabase
      .from("deals")
      .select("id")
      .eq("zoho_id", zoho_deal_id)
      .maybeSingle();

    const dealId = dealRow?.id ?? null;

    // ── Step 5: Which login, which Dealer ID ───────────────────────────
    //
    // Absence is not an error here. A session is still worth creating for a
    // store that has no provider mapping yet -- the deal snapshot is captured,
    // and rating is what will refuse. has_credentials in the response is how
    // the caller learns which it got.
    const { data: acctRow } = await supabase
      .schema("fni")
      .from("store_provider_accounts")
      .select("credential_id, dealer_code")
      .eq("store_id", storeRow.id)
      .eq("provider", "TecAssured")
      .eq("active", true)
      .maybeSingle();

    const credentialId = (acctRow?.credential_id as string | undefined) ?? null;
    const dealerCode = (acctRow?.dealer_code as string | undefined) ?? null;

    // ── Step 6: Create the session ─────────────────────────────────────
    const sessionData = mapSession(
      record,
      storeRow.id,
      storeRow.tenant_id,
      dealId,
      credentialId,
      initiated_by
    );

    const { data: newSession, error: insertErr } = await supabase
      .schema("fni")
      .from("sessions")
      .insert(sessionData)
      .select("id, status")
      .single();

    if (insertErr) throw new Error(`Failed to create session: ${insertErr.message}`);

    // ── Step 7: Hand back the link ─────────────────────────────────────
    return json(200, {
      session_id: newSession.id,
      status: newSession.status,
      menu_url: `${menuBaseUrl}/${newSession.id}`,
      existing: false,
      has_credentials: !!credentialId,
      // The Dealer ID this store will rate under. Reported, not yet recorded:
      // sessions.dealer_code_used is written at rating, by whichever code was
      // actually sent, so it can never claim a dealer that never acted.
      dealer_code: dealerCode,
      store: storeLocation,
      deal_number: text(record.Name),
      buyer: text(record.Buyer_Display_Name),
      vehicle: [
        text(record.Sold_1_Year),
        text(record.Sold_1_Make),
        text(record.Sold_1_Model),
      ].filter(Boolean).join(" "),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-session-start error:", message);
    return json(500, { error: message });
  }
});
