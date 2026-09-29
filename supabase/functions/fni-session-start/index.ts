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
//   3. Return the deal's existing session, refreshed, rather than a duplicate
//   4. Resolve the store's provider mapping -> which login, which Dealer ID
//   5. Map Zoho fields -> fni.sessions snapshot
//   6. Return session_id + menu_url (the Verify screen) + provider status
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
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getRecord, ZohoRecord } from "../_shared/zoho.ts";
import { secretsMatch } from "../_shared/supabase.ts";
import { vtypeForBodyType } from "../_shared/vehicle-types.ts";
import { crmRatingFields } from "../_shared/crm-fields.ts";
import {
  buildVerification,
  changedInputs,
  ratingInputs,
  type VerificationSource,
} from "../_shared/verification.ts";
import { parseRequiredProperties, readRateProperties } from "../_shared/rate-properties.ts";
import {
  contractsAlreadySubmittedMessage,
  describeContract,
  occupiesSlot,
  type ContractRef,
} from "../_shared/duplicates.ts";

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

// The Zoho body type -> TecAssured vtype map lives in _shared/vehicle-types.ts,
// so that the list of vtypes this function can produce and the list
// fni-refresh-rate-properties caches required properties for are one list.
//
// Its old comment said the real types come from getVehicleTypes. They do not:
// that endpoint does not exist. A dealer that does not sell a type answers
// /rate/requiredproperties with nothing, and fni.store_rate_properties records
// that as Unavailable.

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
  const vehicleTypeCode = vtypeForBodyType(bodyType);
  const hasLienholder = !!text(record.Lienholder_Name);
  const financeType = hasLienholder ? "Loan" : "Cash";
  const saleDate = record.Sale_Date ?? null;

  // The corrected finance columns, from creation. The insert used to leave
  // these out, so a new session showed Term and APR as Missing on Verify until
  // the planner's backfill or a Refresh filled them in. Read from
  // crmRatingFields so creation, reopen and Refresh derive them one way.
  const crm = crmRatingFields(record as unknown as Record<string, unknown>);

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
    interest_rate: crm.interest_rate,
    tila_amount_financed: crm.tila_amount_financed,
    finance_term_total: crm.finance_term_total,
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

// ─── The URL the CRM button opens ────────────────────────────────────────
//
// `menu_url` is what the Zoho button opens. Nothing in Deluge builds a URL of
// its own: the button opens whatever this function returns, which is why this is
// the only place that has to change.
//
// ── It now opens Verify, not the presentation (2026-09-27) ───────────────
// It used to be `${FNI_MENU_BASE_URL}/${session_id}`, the presentation itself.
// So a deal that had been verified before went straight in, and a deal that had
// not showed the customer the neutral "still getting your options ready" screen
// while the staff screen nobody had opened sat behind a sign-in.
//
// Every launch from the CRM now lands on Verify first, whatever state the
// session is in: new or existing, verified or not. Verified is not a reason to
// skip it -- the figures may have moved since, and the person about to sit down
// with a customer is the right person to look. A customer reopening their own
// /plan/ link later still goes straight to the presentation; that link is
// unchanged and this function does not hand it to them.
//
// ── Deriving the verify base ─────────────────────────────────────────────
// FNI_MENU_BASE_URL is `https://ps.docuride.com/plan`, so the sibling route is
// `https://ps.docuride.com/verify`. Swapping a trailing `/plan` handles that
// without anybody editing a secret. FNI_VERIFY_BASE_URL overrides it outright if
// the two ever stop being siblings, and the origin fallback covers a base that
// does not end in /plan at all.
function verifyBaseFrom(menuBaseUrl: string): string {
  const explicit = Deno.env.get("FNI_VERIFY_BASE_URL");
  if (explicit && explicit.trim() !== "") return explicit.trim().replace(/\/+$/, "");

  const trimmed = menuBaseUrl.replace(/\/+$/, "");
  if (/\/plan$/i.test(trimmed)) return trimmed.replace(/\/plan$/i, "/verify");

  try {
    return `${new URL(trimmed).origin}/verify`;
  } catch {
    return `${trimmed}/verify`;
  }
}

/** Both links for a session: where the button goes, and where the customer goes. */
function linksFor(menuBaseUrl: string, sessionId: string) {
  const verifyBaseUrl = verifyBaseFrom(menuBaseUrl);
  return {
    // What the Zoho button opens. Verify, always.
    menu_url: `${verifyBaseUrl}/${sessionId}`,
    verify_url: `${verifyBaseUrl}/${sessionId}`,
    // The presentation. Reached by Confirm and Continue, or by a customer
    // reopening a link they already have.
    plan_url: `${menuBaseUrl.replace(/\/+$/, "")}/${sessionId}`,
    // Echoed so a launch says which base it resolved, rather than leaving the
    // answer inside a secret nobody can read back.
    menu_base_url: menuBaseUrl,
    verify_base_url: verifyBaseUrl,
  };
}

// ─── Reopening a deal that already has a session ─────────────────────────
//
// The CRM button is pressed more than once as a matter of course: a salesperson
// reopens the deal, the customer comes back a day later, somebody double-clicks.
// Every one of those used to hand back the session exactly as it was first
// captured, however stale -- so a deal corrected in Zoho an hour ago still rated
// off yesterday's figures.
//
// So a reopen refreshes. And because a refresh can move something a price was
// built on, it can also take a verification away, which is the point: a rate
// nobody has re-checked against the current deal is not a rate to show anybody.
//
// Except when contracts exist. Then nothing is touched at all.

async function reopen(
  supabase: SupabaseClient,
  session: Record<string, unknown>,
  record: ZohoRecord,
  menuBaseUrl: string
): Promise<Response> {
  const sessionId = session.id as string;

  // ── Contracts already submitted: look, do not touch ───────────────────
  //
  // Real paperwork exists at the provider with this customer's name on it.
  // Refreshing the deal underneath it, or resetting a verification it was
  // written from, would leave the record disagreeing with the contract. So the
  // session is handed back exactly as it stands, with the numbers, and a person
  // decides what happens next.
  const { data: agreement } = await supabase
    .schema("fni")
    .from("agreements")
    .select("id")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (agreement) {
    const { data: rows } = await supabase
      .schema("fni")
      .from("agreement_products")
      .select("provider_product_id, contract_number, product_name, status")
      .eq("agreement_id", (agreement as { id: string }).id);

    const contracts = ((rows ?? []) as unknown as ContractRef[]).filter(occupiesSlot);

    if (contracts.length > 0) {
      return json(200, {
        session_id: sessionId,
        status: session.status,
        ...linksFor(menuBaseUrl, sessionId),
        existing: true,
        refreshed: false,
        contracts_submitted: true,
        contract_numbers: contracts.map((c) => c.contract_number).filter((n) => n !== null),
        contracts: contracts.map(describeContract),
        message: contractsAlreadySubmittedMessage(contracts),
      });
    }
  }

  // ── Refresh the rating inputs from the CRM ────────────────────────────
  const patch = crmRatingFields(record as unknown as Record<string, unknown>);

  const { error: patchErr } = await supabase
    .schema("fni")
    .from("sessions")
    .update(patch)
    .eq("id", sessionId);

  if (patchErr) {
    // The session is still usable; it is just carrying the older snapshot. Said
    // plainly rather than failing the button, because refusing to open the
    // planner over a stale field helps nobody standing at a desk.
    console.error(`fni-session-start refresh failed for ${sessionId}: ${patchErr.message}`);
    return json(200, {
      session_id: sessionId,
      status: session.status,
      ...linksFor(menuBaseUrl, sessionId),
      existing: true,
      refreshed: false,
      message: "Existing session reused. The deal data could not be refreshed.",
    });
  }

  const merged = { ...session, ...patch } as Record<string, unknown>;

  // ── Did the refresh move anything a rate is built on? ─────────────────
  const changed = await ratingInputsChanged(supabase, merged);

  let verification = String(session.verification_state ?? "Needs Verification");

  if (changed.length > 0 && verification === "Verified") {
    await supabase
      .schema("fni")
      .from("sessions")
      .update({
        verification_state: "Needs Verification",
        verified_at: null,
        verified_by: null,
        verified_snapshot: null,
      })
      .eq("id", sessionId);

    // The quote is kept and marked, not deleted. It was a real price once and
    // the record of it matters; it is simply not the answer to the current
    // question any more.
    await supabase
      .schema("fni")
      .from("rated_offers")
      .update({ out_of_date: true })
      .eq("session_id", sessionId);

    verification = "Needs Verification";
  }

  return json(200, {
    session_id: sessionId,
    status: session.status,
    ...linksFor(menuBaseUrl, sessionId),
    existing: true,
    refreshed: true,
    changed_inputs: changed,
    verification_state: verification,
    rates_out_of_date: changed.length > 0,
    message:
      changed.length > 0
        ? `Existing session reused and refreshed. ${changed.length} rating ` +
          `${changed.length === 1 ? "input" : "inputs"} changed, so this deal needs ` +
          `verifying again and the old rates are out of date.`
        : "Existing session reused and refreshed. Nothing a rate depends on changed.",
  });
}

/**
 * Which rating inputs differ from what the verifier approved.
 *
 * Compared against the verification snapshot rather than the row before the
 * update, because the question is whether what a person signed off is still
 * true. A field that changed twice and came back is unchanged. The same
 * comparison fni-session-verify's Refresh makes, from the same module.
 */
async function ratingInputsChanged(
  supabase: SupabaseClient,
  session: Record<string, unknown>
): Promise<string[]> {
  const snapshot = (session.verified_snapshot ?? null) as Record<string, unknown> | null;
  const before = (snapshot?.rating_inputs ?? null) as Record<string, string | null> | null;

  // Never verified, so there is nothing to invalidate. Reporting every field as
  // changed here would be true and useless.
  if (!before) return [];

  const vtype = session.vehicle_type_code;
  let properties: string[] = [];

  if (typeof vtype === "string" && vtype.trim() !== "") {
    const { data: account } = await supabase
      .schema("fni")
      .from("store_provider_accounts")
      .select("id")
      .eq("store_id", session.store_id as string)
      .eq("provider", "TecAssured")
      .eq("active", true)
      .maybeSingle();

    if (account) {
      const cached = await readRateProperties(
        supabase,
        (account as { id: string }).id,
        vtype
      );
      if (cached && cached.status === "Cached") {
        properties = parseRequiredProperties(cached.properties).names;
      }
    }
  }

  const after = ratingInputs(
    buildVerification(session as unknown as VerificationSource, properties)
  );

  return changedInputs(before, after);
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

    // ── Step 3: The deal's existing session wins, always ───────────────
    //
    // Any session, whatever its status. This used to exclude Finalized, Written
    // Back and Cancelled, which meant a deal whose session had reached one of
    // those got a SECOND session and a second planner link -- two records of one
    // presentation, and two links a customer could be sent. A deal has one
    // planning session for its whole life; "it is finished" is not a reason to
    // make another one.
    //
    // Migration 0015 adds a unique index on zoho_deal_id, so this is now
    // belt and braces: two simultaneous clicks used to be able to both find
    // nothing and both insert, and the database refuses the second one now.
    const { data: existingSession } = await supabase
      .schema("fni")
      .from("sessions")
      .select("*")
      .eq("zoho_deal_id", zoho_deal_id)
      .maybeSingle();

    const menuBaseUrl = Deno.env.get("FNI_MENU_BASE_URL") ?? "https://docuride.app/fni";

    if (existingSession) {
      return await reopen(
        supabase,
        existingSession as Record<string, unknown>,
        record,
        menuBaseUrl
      );
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
      ...linksFor(menuBaseUrl, newSession.id),
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
