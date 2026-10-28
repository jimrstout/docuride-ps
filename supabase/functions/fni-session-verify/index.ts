// fni-session-verify/index.ts
//
// The staff-only Verify step. Nothing customer-facing ever calls this and
// nothing it returns is written for a customer to read.
//
// ── Why a gate at all ───────────────────────────────────────────────────
// Making the planner rate itself fixed a customer being told their machine had
// no plans. It also meant a rate request would be assembled, unattended, from a
// deal nobody had looked at -- and two of the seventeen fields TecAssured wants
// for a UTV have no source in the CRM. A rate is a price a customer is shown, so
// a person now checks the inputs and says so, and the planner will not rate
// until they have.
//
// Input:
//   GET  ?session_id=<uuid>              -> the sheet: every field, value, source
//   POST { session_id, action }          -> save | refresh | discard_edits | verify
//
// The VIN decode used to be an action here. It is fni-vin-decode now: it was the
// only thing this function did that called the provider, and it made a sheet
// endpoint bundle the entire TecAssured client. See that function's header.
//
// Auth: FNI_WEBHOOK_SECRET, as every other fni function. The console's sign-in
// decides who reaches the layer that holds the secret.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { offerRowsFor, tecAssuredAccount } from "../_shared/provider-rows.ts";
import { hostOf, QA_HOST } from "../_shared/contract-guard.ts";
import { currentRows, familiesFromRows, ratingSummary, type RatingRow } from "../_shared/rating-summary.ts";
import { menuFor, ratingDeal } from "../_shared/rate-session.ts";
import { priceSheetRequiredInputs } from "../_shared/adapters/price-sheet.ts";
import { publishedSheetFor } from "../_shared/price-sheet-rows.ts";
import { resolvedSlotsFor } from "../_shared/menu-template-rows.ts";
import { oemContractList } from "../_shared/oem-contract-rows.ts";
import { contractStateLabel } from "../_shared/oem-contracts.ts";
import { workDriveFileUrl } from "../_shared/workdrive-links.ts";
import { HOLD_BUCKET } from "../_shared/contract-documents.ts";
import { getRecord } from "../_shared/zoho.ts";
import { crmRatingFields } from "../_shared/crm-fields.ts";
import {
  buildVerification,
  changedInputs,
  dealTypeLabel,
  editableKeys,
  editTargetFor,
  labelFor,
  ratingInputs,
  type VerificationSource,
} from "../_shared/verification.ts";
import {
  applyStaffEdits,
  castForColumn,
  castForProperty,
  parseStaffEdits,
  type StaffEdits,
} from "../_shared/staff-edits.ts";
import { parseRequiredProperties, readRateProperties } from "../_shared/rate-properties.ts";
import { dealDates, type DealDateSource } from "../_shared/deal-dates.ts";
import {
  contractParties,
  isPartyKey,
  LOCK_REASON,
  PARTY_FIELDS,
  partyValue,
  REMOVABLE,
  REMOVED,
  type PartyName,
} from "../_shared/contract-parties.ts";
import { plannedDateProblem, storeToday, submitDateProblem } from "../_shared/store-day.ts";
import { capChange, editFor, MAX_AMOUNT_FINANCED } from "./save-edits.ts";
import { keepStaffSaleDate, saleDateChoice } from "../_shared/sale-date.ts";
import {
  duplicateVinWarning,
  occupiesSlot,
  sessionIsOpen,
  TERMINAL_SESSION_STATUSES,
  type ContractRef,
  type OpenSessionRef,
} from "../_shared/duplicates.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The fixed three-key allowlist that used to live here is gone. Which fields may
// be edited is now a property of the sheet's own specs, and it depends on the
// deal: the three finance figures close on a cash deal. editableKeys() is the one
// answer, and the screen greys the same fields this endpoint refuses.

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

function admin(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

/** The session columns this function reads. Explicit, so a new PII column on
 *  fni.sessions cannot widen what a staff screen receives by accident. */
const COLUMNS = [
  "id", "store_id", "tenant_id", "zoho_deal_id", "status", "is_test",
  "deal_number", "stock_number", "finance_type", "sale_date",
  "vin", "unit_year", "unit_make", "unit_model", "condition",
  "vehicle_type_code", "odometer", "in_service_date",
  // The vehicle type choice and where it came from. Migration 0031.
  "vehicle_type", "vehicle_type_source",
  "sale_price", "amount_financed", "finance_term", "apr",
  // The corrected finance columns the sheet resolves the term and rate from.
  // Without these on the select, deal 13759's 60 months at 6.99% read as
  // Missing and Confirm and Continue stayed disabled on a deal the CRM had
  // complete. See _shared/finance-basis.ts.
  "interest_rate", "finance_term_total", "tila_amount_financed", "lienholder_name",
  // Financial, shown on the sheet and not rating inputs. Migration 0018.
  "agreed_down_payment", "max_amount_financed",
  "buyer_city", "buyer_state", "buyer_zip",
  // Who goes on the contracts: the buyer, co-buyer and lienholder, shown and
  // edited in their own panels (_shared/contract-parties.ts). The page shows
  // them only to a signed-in operator; this function serves the page's server,
  // never a browser.
  "buyer_type", "buyer_display_name", "buyer_first_name", "buyer_last_name", "buyer_address",
  "buyer_phone", "buyer_email",
  "cobuyer_type", "cobuyer_display_name", "cobuyer_first_name", "cobuyer_last_name", "cobuyer_address",
  "cobuyer_city", "cobuyer_state", "cobuyer_zip", "cobuyer_phone", "cobuyer_email",
  "lienholder_address", "lienholder_city", "lienholder_state", "lienholder_zip", "lienholder_phone",
  "vehicle_properties", "vin_decode", "vin_decode_at",
  // The last decode attempt, successful or not. The Verify page decodes on its
  // own only when both this and vin_decode_at are empty, so a TecAssured outage
  // costs one try per session rather than one per page load. Migration 0017.
  "vin_decode_attempted_at", "vin_decode_error",
  "verification_state", "verified_at", "verified_by", "verified_snapshot",
  // For the duplicate warnings and the submit lock, both of which the verify
  // screen now shows.
  "expires_at", "submit_state", "submit_detail",
  // The day the deal is planned to be sold, for preparing it the night
  // before. Migration 0038.
  "planned_sale_date",
  // The staff layer over the CRM's figures. Migration 0016.
  "staff_edits",
  // Which providers the latest rating covered. Multi-provider Part 4.
  "rated_provider_ids",
  // The menu template rating matched, for the hidden-slot notes. Part 7.
  "menu_template_id",
].join(",");

async function loadSession(
  supabase: SupabaseClient,
  sessionId: string
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .schema("fni")
    .from("sessions")
    .select(COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * Case 3: the same machine on another open deal.
 *
 * Read-only and advisory. Nothing is blocked, because two deals on one VIN is
 * as often a legitimate re-write as it is a mistake, and DocuRide cannot tell
 * which from here. Staff can.
 *
 * Scoped to the tenant: two dealer groups can honestly hold the same VIN, one
 * having sold the machine to the other.
 */
async function duplicateVinSessions(
  supabase: SupabaseClient,
  s: Record<string, unknown>
): Promise<OpenSessionRef[]> {
  const vin = typeof s.vin === "string" ? s.vin.trim() : "";
  if (vin === "") return [];

  let q = supabase
    .schema("fni")
    .from("sessions")
    .select("id, deal_number, status, expires_at")
    .eq("vin", vin)
    .neq("id", s.id as string)
    .not("status", "in", `(${TERMINAL_SESSION_STATUSES.join(",")})`);

  if (typeof s.tenant_id === "string" && s.tenant_id !== "") {
    q = q.eq("tenant_id", s.tenant_id);
  }

  const { data } = await q;
  return ((data ?? []) as OpenSessionRef[]).filter((o) => sessionIsOpen(o));
}

/**
 * Contracts already on this session.
 *
 * The verify screen is where staff land when CRM sends a deal through a second
 * time, so it is where "this is already done" has to be visible. Voided rows
 * are left out: they no longer hold a product's slot, and listing them would
 * read as paperwork that still stands.
 */
/** Statuses at which the customer has finished choosing in the planner. */
const PLANNER_DONE = ["Products Selected", "Agreement Created", "Finalized"];

/**
 * The staff contracts panel: what the customer chose from providers
 * contracted through their API, and every contract submitted for them,
 * voided ones included, with its saved WorkDrive file.
 */
async function contractsPanel(supabase: SupabaseClient, s: Record<string, unknown>) {
  if (!PLANNER_DONE.includes(String(s.status))) return null;

  const { data: chosen } = await supabase
    .schema("fni")
    .from("selected_products")
    .select("provider_id, provider_product_id, product_name, term_months, term_miles, customer_price, providers!inner(name, contract_method)")
    .eq("session_id", s.id as string)
    .eq("disposition", "Included")
    .eq("providers.contract_method", "Through API")
    .order("product_name");
  const chosenRows = (chosen ?? []) as unknown as {
    provider_id: string;
    provider_product_id: string | null;
    product_name: string;
    term_months: number | null;
    term_miles: number | null;
    customer_price: number | null;
    providers: { name: string };
  }[];
  const programs = await programNamesFor(supabase, chosenRows.map((c) => c.provider_id));
  const programOf = (providerId: unknown, code: unknown) =>
    programs.get(`${providerId}|${code}`) ?? null;
  const selections = chosenRows.map((c) => ({
    product_name: c.product_name,
    program_name: programOf(c.provider_id, c.provider_product_id),
    provider_name: c.providers.name,
    term_months: c.term_months,
    term_miles: c.term_miles,
    customer_price: c.customer_price,
  }));
  if (selections.length === 0) return null;

  const { data: agreement } = await supabase
    .schema("fni")
    .from("agreements")
    .select("id")
    .eq("session_id", s.id as string)
    .maybeSingle();
  let contracts: Record<string, unknown>[] = [];
  if (agreement) {
    const { data } = await supabase
      .schema("fni")
      .from("agreement_products")
      .select(
        "provider_id, provider_product_id, contract_number, product_name, status, document_position, " +
          "workdrive_file_id, workdrive_file_name, " +
          "workdrive_saved_at, voided_by, voided_at, void_reason, page_count, document_status, document_storage_path"
      )
      .eq("agreement_id", (agreement as { id: string }).id)
      .is("recorded_by", null)
      .order("document_position", { ascending: true, nullsFirst: false });
    contracts = await Promise.all(
      ((data ?? []) as unknown as Record<string, unknown>[]).map(async (c) => {
        // A held PDF, seen through a ten-minute link: the bucket is private.
        let view: string | null = null;
        if (c.document_storage_path) {
          const { data: link } = await supabase.storage
            .from(HOLD_BUCKET)
            .createSignedUrl(String(c.document_storage_path), 600);
          view = link?.signedUrl ?? null;
        }
        const { document_storage_path: _path, provider_id: _provider, ...shown } = c;
        return {
          ...shown,
          program_name: programOf(c.provider_id, c.provider_product_id),
          held: !!c.document_storage_path,
          view_pdf_url: view,
          workdrive_url: c.workdrive_file_id ? workDriveFileUrl(String(c.workdrive_file_id)) : null,
        };
      })
    );
  }
  // Held documents not in the Deal Jacket yet, voided ones included.
  const waiting = contracts.filter((c) => c.held && !c.workdrive_file_id).length;
  return {
    provider_name: selections[0].provider_name,
    selections,
    contracts,
    waiting_count: waiting,
    // TEMPORARY: the co-buyer field test is offered on test sessions on the
    // QA server only (_shared/cobuyer-probe.ts).
    cobuyer_probe_available: s.is_test === true && (await onQaServer(supabase, String(s.store_id))),
  };
}

/**
 * Does this store's TecAssured login point at the QA server? Reads the base
 * URL only, never the login itself.
 */
async function onQaServer(supabase: SupabaseClient, storeId: string): Promise<boolean> {
  const account = await tecAssuredAccount(supabase, storeId).catch(() => null);
  if (!account?.credential_id) return false;
  const { data } = await supabase
    .schema("fni")
    .from("provider_credentials")
    .select("api_base_url")
    .eq("id", account.credential_id)
    .maybeSingle();
  return hostOf((data as { api_base_url?: string | null } | null)?.api_base_url) === QA_HOST;
}

/**
 * TecAssured's program name for each catalog product, keyed provider|code.
 * Staff only: it tells twins apart ("USED BRONZE ON-ROAD NON-EU").
 */
async function programNamesFor(
  supabase: SupabaseClient,
  providerIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(providerIds)];
  if (ids.length === 0) return out;
  const { data } = await supabase
    .schema("fni")
    .from("product_catalog")
    .select("provider_id, product_code, provider_program_name")
    .in("provider_id", ids)
    .is("store_id", null)
    .not("provider_program_name", "is", null);
  for (const r of (data ?? []) as { provider_id: string; product_code: string; provider_program_name: string }[]) {
    out.set(`${r.provider_id}|${r.product_code}`, r.provider_program_name);
  }
  return out;
}

async function liveContracts(
  supabase: SupabaseClient,
  sessionId: string
): Promise<ContractRef[]> {
  const { data: agreements } = await supabase
    .schema("fni")
    .from("agreements")
    .select("id")
    .eq("session_id", sessionId);

  const ids = ((agreements ?? []) as { id: string }[]).map((a) => a.id);
  if (ids.length === 0) return [];

  const { data } = await supabase
    .schema("fni")
    .from("agreement_products")
    .select("provider_product_id, contract_number, product_name, status, recorded_by")
    .in("agreement_id", ids);

  return ((data ?? []) as ContractRef[]).filter(occupiesSlot);
}

/**
 * What TecAssured asks for, for this store and this vehicle type.
 *
 * From the cache only. A cold cache returns nothing and the sheet is then not
 * ready, which is the honest answer: we do not yet know what is needed, and a
 * screen that lets Verify be pressed while not knowing is the thing this
 * function exists to prevent. fni-refresh-rate-properties fills the cache
 * overnight, and fni-rate-vehicle fills it on demand.
 */
async function requiredFor(
  supabase: SupabaseClient,
  storeId: string,
  vtype: unknown
): Promise<{ properties: string[]; reason: string | null }> {
  if (typeof vtype !== "string" || vtype.trim() === "") {
    return {
      properties: [],
      reason:
        "This unit has no TecAssured vehicle type, so there is no list of " +
        "fields to check. The deal's body type is either blank or not one we map.",
    };
  }

  const account = await tecAssuredAccount(supabase, storeId);

  if (!account) {
    return {
      properties: [],
      reason: "This store has no active TecAssured mapping, so nothing can be rated for it.",
    };
  }

  const cached = await readRateProperties(
    supabase,
    (account as { id: string }).id,
    vtype
  );

  if (!cached || cached.status !== "Cached") {
    return {
      properties: [],
      reason:
        `We have not yet asked TecAssured what it needs to rate a ${vtype} for ` +
        `this store. Press Refresh, or wait for tonight's refresh.`,
    };
  }

  return { properties: parseRequiredProperties(cached.properties).names, reason: null };
}

/** The sheet, plus everything the screen shows around it. */
async function sheetFor(supabase: SupabaseClient, s: Record<string, unknown>) {
  const edits = parseStaffEdits(s.staff_edits);

  // The required-properties lookup has to use the EDITED vehicle type, not the
  // CRM one. That is the whole point of making it editable: a Defender whose
  // body type nobody has fixed in Zoho is corrected to UTV here, and the very
  // next thing that must change is which seventeen fields TecAssured is asking
  // for. Looking it up from the CRM value would leave the screen checking the
  // wrong list against the right vehicle.
  const edited = applyStaffEdits(s, edits, editTargetFor);

  // ── Which providers this deal's menu needs, and what each asks for ─────
  // The template is matched on the edited values, exactly as rating will
  // match it, and Verify asks for the union of the inputs of the providers its
  // slots need: TecAssured's required properties when Riders Advantage is on
  // the menu, and whatever each Price Sheet provider's Published sheet tests.
  const deal = ratingDeal({ ...edited, store_id: s.store_id });
  const menu = await menuFor(supabase, s.tenant_id as string, deal);
  const needsTecAssured = menu.providers.some((p) => p.adapter === "TecAssured");

  const { properties: taProperties, reason: taReason } = needsTecAssured
    ? await requiredFor(supabase, s.store_id as string, edited.vehicle_type_code)
    : { properties: [] as string[], reason: null };

  const sheetInputs = await Promise.all(
    menu.providers
      .filter((p) => p.kind === "Price Sheet")
      .map(async (p) => {
        // No sale date, no sheet in force to ask: the sheet marks the sale
        // date missing on its own, and today is never used instead.
        if (!deal.sale_date) return [];
        const { sheet, rates } = await publishedSheetFor(supabase, p.id, deal.sale_date);
        return sheet ? priceSheetRequiredInputs(rates) : [];
      })
  );
  const properties = [...new Set([...taProperties, ...sheetInputs.flat()])];
  const reason = taReason;
  const sheet = buildVerification(s as unknown as VerificationSource, properties, edits);

  // ── The rating, per provider ──────────────────────────────────────────
  const rows = currentRows(
    (await offerRowsFor(supabase, s.id as string)) as unknown as RatingRow[],
    s.rated_provider_ids as string[] | null
  );
  const summary = ratingSummary(rows);

  // ── The menu's slots, as rating left them ─────────────────────────────
  // A slot nothing was offered for is not shown to the customer. Staff see
  // which, and why, here: it is the answer to "where did Theft go?".
  const resolved = summary.state === "Rated" && !summary.out_of_date
    ? await resolvedSlotsFor(
        supabase,
        typeof s.menu_template_id === "string" ? s.menu_template_id : null,
        familiesFromRows(rows)
      )
    : null;

  const [duplicates, contracts, oemContracts, panel] = await Promise.all([
    duplicateVinSessions(supabase, s),
    liveContracts(supabase, s.id as string),
    oemContractList(supabase, s.id as string),
    contractsPanel(supabase, s),
  ]);

  return {
    session: {
      id: s.id,
      deal_number: s.deal_number,
      stock_number: s.stock_number,
      status: s.status,
      is_test: s.is_test === true,
      vehicle: [s.unit_year, s.unit_make, s.unit_model]
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
        .join(" "),
      deal_type: dealTypeLabel(edited.finance_type),
      vehicle_type_code: edited.vehicle_type_code,
    },
    verification: {
      state: s.verification_state ?? "Needs Verification",
      verified_at: s.verified_at ?? null,
      verified_by: s.verified_by ?? null,
    },
    // One status across providers, so the page's badge and its gate read as
    // before, and a line per provider: "Riders Advantage: Rated, 11 products."
    rating: {
      state: summary.state,
      product_count: summary.product_count,
      out_of_date: summary.out_of_date,
      rated_at: summary.rated_at,
      detail: summary.state === "Rated" ? null : summary.detail,
      providers: summary.providers.map((p) => ({
        name: p.name,
        state: p.state,
        line: p.line,
        error: p.error,
        error_at: p.error_at,
        kept_error: p.kept_error,
        kept_error_at: p.kept_error_at,
      })),
    },
    // The template the deal matches now. Rating records it on the session.
    menu_template: menu.template ? { name: menu.template.name } : null,
    // Slots hidden from the customer on this deal, with the reason for staff.
    hidden_slots: (resolved ?? [])
      .filter((r) => r.hidden)
      .map((r) => ({ title: r.title, note: r.staff_note })),
    // OEM selections, whose contracts staff write on the OEM's system and
    // record here. See fni-oem-contracts.
    oem_contracts: oemContracts,
    // The staff contracts panel, once the customer has finished the planner.
    contracts_panel: panel,
    vin_decode: s.vin_decode ?? null,
    vin_decode_at: s.vin_decode_at ?? null,
    vin_decode_attempted_at: s.vin_decode_attempted_at ?? null,
    vin_decode_error: s.vin_decode_error ?? null,
    // Case 3. A warning with the other deal numbers in it, and the ids so the
    // screen can link straight there rather than making staff go hunting.
    duplicate_vin: duplicates.length > 0
      ? {
          message: duplicateVinWarning(duplicates),
          sessions: duplicates.map((d) => ({
            id: d.id,
            deal_number: d.deal_number,
            status: d.status,
          })),
        }
      : null,
    // Case 1 and 2, seen from the staff side: paperwork that already exists.
    contracts: contracts.map((c) => ({
      contract_number: c.contract_number,
      provider_product_id: c.provider_product_id,
      product_name: c.product_name,
      status: contractStateLabel(c as { status: string; recorded_by?: string | null }),
    })),
    submit_state: s.submit_state ?? "Idle",
    submit_detail: s.submit_detail ?? null,
    // The store's day: when this session ends, the planned sale date, and
    // whether Submit would be refused on the deal's dates today
    // (_shared/store-day.ts). Submit checks the same thing again itself.
    day: await dayFor(supabase, s, edited),
    // The buyer, co-buyer and lienholder, as the contracts will carry them,
    // locked while any contract on the deal is live.
    contract_parties: contractParties(s, edits, contracts.length > 0),
    // A staff sale date (Renew for Today moves a past one to today) that the
    // CRM disagrees with: Keep staff value or Use CRM value, as on the panels.
    sale_date_choice: saleDateChoice(s, edits),
    // Why nothing is required, when nothing is. Shown instead of a sheet that
    // looks complete because it is asking for nothing.
    not_ready_reason: reason,
    ...sheet,
  };
}

/**
 * Did anything a rate depends on move since the session was verified?
 *
 * Compared against the snapshot taken at verification, with the staff layer
 * applied, because the question is whether what the verifier approved is
 * still what would be sent. If something moved, the session needs Confirm and
 * Continue again and its quotes are marked out of date (kept, never deleted).
 * Shared by Refresh and Save: a corrected rating input, such as the vehicle
 * type, is exactly such a move. Returns the inputs that moved.
 */
async function unverifyIfInputsMoved(
  supabase: SupabaseClient,
  fresh: Record<string, unknown>
): Promise<string[]> {
  const freshEdits = parseStaffEdits(fresh.staff_edits);

  // A field that changed twice and came back is unchanged.
  const { properties } = await requiredFor(
    supabase,
    fresh.store_id as string,
    (applyStaffEdits(fresh, freshEdits, editTargetFor)).vehicle_type_code
  );
  // With the edits applied, because the question is whether what the verifier
  // approved is still what would be sent, and what would be sent includes their
  // corrections. A CRM field that moved underneath an edit changes nothing the
  // provider sees, so it must not un-verify the session; it shows up in the
  // mismatch warning instead, which is where it belongs.
  const after = ratingInputs(
    buildVerification(fresh as unknown as VerificationSource, properties, freshEdits)
  );

  const snapshot = (fresh.verified_snapshot ?? null) as Record<string, unknown> | null;
  const before = (snapshot?.rating_inputs ?? null) as Record<string, string | null> | null;

  const changed = fresh.verification_state === "Verified" ? changedInputs(before, after) : [];

  if (changed.length > 0) {
    await supabase
      .schema("fni")
      .from("sessions")
      .update({
        verification_state: "Needs Verification",
        verified_at: null,
        verified_by: null,
        verified_snapshot: null,
      })
      .eq("id", fresh.id as string);

    // The quote is not deleted. It was a real price once and the record of it
    // matters; it just is not the answer to the current question any more.
    await supabase
      .schema("fni")
      .from("rated_offers")
      .update({ out_of_date: true })
      .eq("session_id", fresh.id as string);
  }

  return changed;
}

// ── save: any field that feeds a rate ─────────────────────────────────────

async function save(
  supabase: SupabaseClient,
  s: Record<string, unknown>,
  entries: Record<string, unknown>,
  editedBy: string
): Promise<Response> {
  const edits = parseStaffEdits(s.staff_edits);

  // What each field says with no staff layer at all. This is where an edit's
  // "original" comes from, and taking it from the unedited sheet rather than from
  // the row is what makes it read the way the screen showed it: "$24,000.00",
  // not 24000. requiredProperties is irrelevant to resolving a value, so the
  // lookup is skipped.
  const base = buildVerification(s as unknown as VerificationSource, []);
  const baseByKey = new Map(base.fields.map((f) => [f.key, f]));

  // Editability depends on the deal as it now stands, edits included: changing
  // the deal type from Cash to Finance in the same save that sets the APR has to
  // let the APR through.
  const provisional = applyStaffEdits(s, edits, editTargetFor) as unknown as VerificationSource;
  const allowed = editableKeys(provisional);

  const rejected: string[] = [];
  const unreadable: { key: string; label: string; value: string }[] = [];
  const now = new Date().toISOString();
  // Columns this save writes besides staff_edits. Only the maximum amount
  // financed, which has no other source. See ./save-edits.ts.
  const columns: Record<string, unknown> = {};

  for (const [rawKey, rawValue] of Object.entries(entries)) {
    // ── Framework plumbing is not an edit ──────────────────────────────────────
    // Next.js Server Action forms carry a hidden $ACTION_ID_<hash> field of their
    // own. The console filters to known rating inputs before it posts, so this
    // should never fire -- but it is the thing that actually broke, and refusing a
    // whole save over React's internals is bad enough to be worth blocking twice.
    // Skipped rather than rejected: it is not a field anybody asked to edit.
    if (rawKey.startsWith("$")) continue;

    const key = allowed.find((k) => k.toLowerCase() === rawKey.toLowerCase());
    // City, state and ZIP are on the contracts too, so they lock with the
    // contract panels once a contract is live (_shared/contract-parties.ts).
    if (key && isPartyKey(key) && (await liveContracts(supabase, s.id as string)).length > 0) {
      return json(409, { error: LOCK_REASON });
    }
    if (!key) {
      // Either a field nothing may edit -- Deal #, Stock # and Lender -- or one
      // closed by the deal as it stands, such as APR on a cash deal. Refused by
      // name rather than ignored, because silently dropping somebody's correction
      // is worse than saying no to it.
      //
      // The console no longer sends anything but known rating inputs, so this
      // should only ever name a real field now. It used to receive React's hidden
      // $ACTION_ID field and refuse every save on this line.
      rejected.push(rawKey);
      continue;
    }

    const value = rawValue === null || rawValue === undefined ? "" : String(rawValue).trim();

    // ── The maximum amount financed ────────────────────────────────────────
    // Its own column, with the name and time recorded in staff_edits. Never a
    // rating input, so nothing here touches verification or the rates.
    if (key === MAX_AMOUNT_FINANCED) {
      const change = capChange(value, s.max_amount_financed, editedBy, now);
      if (change.kind === "unreadable") {
        unreadable.push({ key, label: labelFor(key), value });
      } else if (change.kind === "set") {
        columns.max_amount_financed = change.column;
        if (change.edit) edits[key] = change.edit;
        else delete edits[key];
      }
      continue;
    }

    // Cleared means "go back to what the source says", which is the only way out
    // of an edit other than Discard.
    if (value === "") {
      delete edits[key];
      continue;
    }

    // Refused before it is stored, not after. A price that cannot be read as a
    // number would sit in the layer doing nothing while the screen implied it had
    // taken effect.
    const target = editTargetFor(key);
    if (target && target.kind === "column" && castForColumn(target, value) === null) {
      unreadable.push({ key, label: labelFor(key), value });
      continue;
    }

    // A field kept in vehicle_properties. Fuel type takes only Gasoline,
    // Electric or Diesel, and is stored as the word.
    let stored = value;
    if (target && target.kind === "property") {
      const cast = castForProperty(target, value);
      if (cast === null) {
        unreadable.push({ key, label: labelFor(key), value });
        continue;
      }
      stored = cast;
    }

    // ── Only a real change is an edit ──────────────────────────────────────
    // The form posts every input, pre-filled with what the sheet showed, so a
    // value that means the same as the unedited one is not an edit, and it
    // clears any earlier edit to that field. Compared by meaning, not by
    // string: "$24,999.00" and "24999" are one price. See ./save-edits.ts.
    const edit = editFor(target, stored, baseByKey.get(key), edits[key], editedBy, now);
    if (edit === null) {
      delete edits[key];
      continue;
    }
    edits[key] = edit;
  }

  if (rejected.length > 0) {
    return json(400, {
      error:
        `These fields cannot be edited here: ${rejected.map(labelFor).join(", ")}. ` +
        `Deal # and Stock # identify the deal, Lender comes from the CRM deal, ` +
        `and the finance figures are fixed at zero on a cash deal.`,
      rejected,
    });
  }

  if (unreadable.length > 0) {
    return json(400, {
      error:
        `These values could not be read: ` +
        `${unreadable.map((u) => `${u.label} ("${u.value}")`).join(", ")}. ` +
        `Enter a plain number for money, a whole number for months and miles, ` +
        `a date as YYYY-MM-DD, and a fuel type as Gasoline, Electric or Diesel.`,
      unreadable,
    });
  }

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({ staff_edits: Object.keys(edits).length > 0 ? edits : null, ...columns })
    .eq("id", s.id as string);

  if (error) return json(500, { error: error.message });

  const fresh = (await loadSession(supabase, s.id as string))!;
  // A changed rating input (the vehicle type above all, which also re-matches
  // the menu) means the deal needs Confirm and Continue again.
  const changed = await unverifyIfInputsMoved(supabase, fresh);
  const latest = changed.length > 0 ? (await loadSession(supabase, s.id as string))! : fresh;
  return json(200, { ...(await sheetFor(supabase, latest)), changed_inputs: changed });
}

// ── discard: put the CRM's figures back ───────────────────────────────────

/**
 * "Discard my edits and reload from CRM."
 *
 * Drops every edit to a field the CRM carries, then re-pulls the deal. The
 * fields CRM does NOT carry -- engine size, factory warranty, fuel type -- are
 * kept, because there is nothing to reload them from and throwing them away
 * would leave the session unrateable for no reason at all. The screen says so
 * under the button rather than leaving it as a surprise.
 */
async function discardEdits(
  supabase: SupabaseClient,
  s: Record<string, unknown>
): Promise<Response> {
  const edits = parseStaffEdits(s.staff_edits);
  const base = buildVerification(s as unknown as VerificationSource, []);
  const crmOwned = new Set(base.fields.filter((f) => f.in_crm).map((f) => f.key));

  // City, state and ZIP are contract details too: while a contract is live
  // they are locked, so a discard keeps them (_shared/contract-parties.ts).
  const locked = (await liveContracts(supabase, s.id as string)).length > 0;
  const kept: StaffEdits = {};
  const discarded: string[] = [];
  for (const [key, edit] of Object.entries(edits)) {
    if (crmOwned.has(key) && !(locked && isPartyKey(key))) discarded.push(labelFor(key));
    else kept[key] = edit;
  }

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({ staff_edits: Object.keys(kept).length > 0 ? kept : null })
    .eq("id", s.id as string);

  if (error) return json(500, { error: error.message });

  const fresh = (await loadSession(supabase, s.id as string))!;

  // Then reload, which is the other half of what the button says. A session with
  // no CRM deal behind it has nothing to reload from, and that is not a failure:
  // the discard still happened.
  if (typeof fresh.zoho_deal_id === "string" && fresh.zoho_deal_id !== "") {
    return await refresh(supabase, fresh, discarded);
  }

  return json(200, {
    ...(await sheetFor(supabase, fresh)),
    discarded_edits: discarded,
    refreshed: false,
  });
}

// ── Who goes on the contracts ─────────────────────────────────────────────
//
// party_save        { entries: { buyer_last_name: "...", ... } }
// party_remove      { party: "Co-buyer" | "Lienholder" }
// party_restore     { party: "Co-buyer" | "Lienholder" }
// party_keep_staff  { key }   the CRM changed: keep the staff value
// party_use_crm     { key }   the CRM changed: drop the edit, use the CRM's
//
// Each is a staff edit (_shared/contract-parties.ts), refused while a contract
// on the deal is live. City, state and ZIP feed the rate too, so a change to
// them sends the deal back through Confirm and Continue, as on the sheet.

async function partyAction(
  supabase: SupabaseClient,
  s: Record<string, unknown>,
  action: string,
  body: Record<string, unknown>,
  who: string
): Promise<Response> {
  if ((await liveContracts(supabase, s.id as string)).length > 0) {
    return json(409, { error: LOCK_REASON });
  }
  const edits = parseStaffEdits(s.staff_edits);
  const now = new Date().toISOString();
  const crm = (key: string): string | null => {
    const v = s[key];
    const t = v === null || v === undefined ? "" : String(v).trim();
    return t === "" ? null : t;
  };
  const removable = (v: unknown): PartyName | null =>
    v === "Co-buyer" || v === "Lienholder" ? v : null;

  if (action === "party_save") {
    const entries = body.entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return json(400, { error: "entries must be an object" });
    }
    const problems: string[] = [];
    for (const [key, raw] of Object.entries(entries as Record<string, unknown>)) {
      const spec = PARTY_FIELDS.find((f) => f.key === key);
      if (!spec) continue; // Form plumbing, not a field.
      const typed = raw === null || raw === undefined ? "" : String(raw).trim();
      // Blank means "what the CRM says", the same as clearing a box on the sheet.
      if (typed === "") {
        delete edits[key];
        continue;
      }
      const checked = partyValue(spec, typed);
      if ("problem" in checked) {
        problems.push(checked.problem);
        continue;
      }
      const original = crm(key);
      const edit = editFor(
        editTargetFor(key),
        checked.value,
        { value: original, source: original === null ? "Missing" : "CRM" },
        edits[key],
        who,
        now
      );
      if (edit === null) delete edits[key];
      else edits[key] = edit;
    }
    if (problems.length > 0) return json(400, { error: problems.join(" "), problems });
  } else if (action === "party_remove" || action === "party_restore") {
    const party = removable(body.party);
    if (!party) return json(400, { error: "party must be Co-buyer or Lienholder" });
    const marker = REMOVABLE[party as "Co-buyer" | "Lienholder"];
    if (action === "party_restore") {
      delete edits[marker];
    } else {
      // Its own field edits go with it: they described the one being removed.
      for (const f of PARTY_FIELDS) if (f.party === party) delete edits[f.key];
      const crmHad = PARTY_FIELDS.filter((f) => f.party === party).some((f) => crm(f.key) !== null);
      if (crmHad) {
        edits[marker] = { value: REMOVED, original: null, original_source: "CRM", edited_by: who, edited_at: now };
      }
    }
  } else if (action === "party_keep_staff" || action === "party_use_crm") {
    const key = typeof body.key === "string" ? body.key : "";
    if (!isPartyKey(key) || !edits[key]) return json(400, { error: "That field has no staff value." });
    if (action === "party_use_crm") delete edits[key];
    // Keep: the edit stays, and now records what the CRM says as the value it
    // replaces, so the difference is acknowledged and no longer flagged.
    else edits[key] = { ...edits[key], original: crm(key), original_source: crm(key) === null ? "Missing" : "CRM", edited_by: who, edited_at: now };
  } else {
    return json(400, { error: `Unknown action ${action}` });
  }

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({ staff_edits: Object.keys(edits).length > 0 ? edits : null })
    .eq("id", s.id as string);
  if (error) return json(500, { error: error.message });

  const fresh = (await loadSession(supabase, s.id as string))!;
  const changed = await unverifyIfInputsMoved(supabase, fresh);
  const latest = changed.length > 0 ? (await loadSession(supabase, s.id as string))! : fresh;
  return json(200, { ...(await sheetFor(supabase, latest)), changed_inputs: changed });
}

// ── The sale date, when the CRM says otherwise ────────────────────────────
//
// sale_date_keep_staff   the staff date stands; not asked again for this CRM date
// sale_date_use_crm      drop the edit and use the CRM's date
//
// The sale date is a rating input, so using the CRM's sends the deal back
// through Confirm and Continue and marks the rates out of date, as any change
// to it does (_shared/sale-date.ts).

async function saleDateAction(
  supabase: SupabaseClient,
  s: Record<string, unknown>,
  action: string,
  who: string
): Promise<Response> {
  const edits = parseStaffEdits(s.staff_edits);
  const edit = edits.sale_date;
  if (!edit) return json(400, { error: "The sale date has no staff value." });
  if (action === "sale_date_use_crm") delete edits.sale_date;
  else edits.sale_date = keepStaffSaleDate(edit, s.sale_date, who, new Date().toISOString());

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({ staff_edits: Object.keys(edits).length > 0 ? edits : null })
    .eq("id", s.id as string);
  if (error) return json(500, { error: error.message });

  const fresh = (await loadSession(supabase, s.id as string))!;
  const changed = await unverifyIfInputsMoved(supabase, fresh);
  const latest = changed.length > 0 ? (await loadSession(supabase, s.id as string))! : fresh;
  return json(200, { ...(await sheetFor(supabase, latest)), changed_inputs: changed });
}

// ── The store's day ───────────────────────────────────────────────────────

async function storeTimeZone(supabase: SupabaseClient, storeId: unknown): Promise<string | null> {
  if (typeof storeId !== "string") return null;
  const { data } = await supabase.from("stores").select("time_zone").eq("id", storeId).maybeSingle();
  return (data as { time_zone?: string } | null)?.time_zone ?? null;
}

async function dayFor(supabase: SupabaseClient, s: Record<string, unknown>, edited: DealDateSource) {
  const timeZone = await storeTimeZone(supabase, s.store_id);
  const today = storeToday(timeZone);
  const planned = typeof s.planned_sale_date === "string" ? s.planned_sale_date : null;
  const dates = dealDates(edited);
  return {
    time_zone: timeZone,
    today,
    expires_at: s.expires_at ?? null,
    planned_sale_date: planned,
    sale_date: dates.sale,
    submit_problem: submitDateProblem({ sale: dates.sale, inService: dates.inService, planned, today }),
  };
}

/**
 * Set or clear the planned sale date. The session then lasts to the end of
 * that day, or of today when it is cleared (fni.renew_session, migration 0038).
 * Never sent to a provider: the sale date is the deal's own.
 */
async function setPlannedSaleDate(
  supabase: SupabaseClient,
  s: Record<string, unknown>,
  value: unknown
): Promise<Response> {
  const raw = typeof value === "string" ? value.trim() : "";
  const planned = raw === "" ? null : raw;
  const today = storeToday(await storeTimeZone(supabase, s.store_id));
  const problem = plannedDateProblem(planned, today);
  if (problem) return json(400, { error: problem });

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({ planned_sale_date: planned })
    .eq("id", s.id as string);
  if (error) return json(500, { error: error.message });

  const { error: renewErr } = await supabase.schema("fni").rpc("renew_session", { p_session: s.id as string });
  if (renewErr) return json(500, { error: renewErr.message });

  console.log(`fni-session-verify planned_sale_date ${s.id} = ${planned ?? "(cleared)"}`);
  const fresh = (await loadSession(supabase, s.id as string))!;
  return json(200, await sheetFor(supabase, fresh));
}

// ── refresh: re-pull the deal from the CRM ────────────────────────────────

async function refresh(
  supabase: SupabaseClient,
  s: Record<string, unknown>,
  discarded: string[] | null = null
): Promise<Response> {
  const zohoId = typeof s.zoho_deal_id === "string" ? s.zoho_deal_id : null;
  if (!zohoId) {
    return json(400, {
      error:
        "This session has no CRM deal behind it, so there is nothing to refresh. " +
        "Test sessions are created without one.",
    });
  }

  let record;
  try {
    record = await getRecord("DocuRide", zohoId);
  } catch (err) {
    return json(502, {
      error: `Could not read the deal from CRM: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!record) {
    return json(404, { error: `CRM has no DocuRide record ${zohoId} any more.` });
  }

  // Only the CRM's own columns. sessions.staff_edits is not in this patch and is
  // not cleared anywhere in this function, which is how a refresh keeps staff
  // edits: the layer sits above the columns being rewritten. Discard is the only
  // thing that drops them.
  const patch = crmRatingFields(record as unknown as Record<string, unknown>);

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update(patch)
    .eq("id", s.id as string);

  if (error) return json(500, { error: error.message });

  const fresh = (await loadSession(supabase, s.id as string))!;
  const changed = await unverifyIfInputsMoved(supabase, fresh);

  const latest = (await loadSession(supabase, fresh.id as string))!;
  return json(200, {
    ...(await sheetFor(supabase, latest)),
    refreshed: true,
    changed_inputs: changed,
    // Present only when this refresh came from Discard.
    discarded_edits: discarded ?? undefined,
  });
}

// ── verify: the gate ──────────────────────────────────────────────────────

async function verify(
  supabase: SupabaseClient,
  s: Record<string, unknown>,
  verifiedBy: string
): Promise<Response> {
  const edits = parseStaffEdits(s.staff_edits);
  const edited = applyStaffEdits(s, edits, editTargetFor);
  const { properties, reason } = await requiredFor(
    supabase,
    s.store_id as string,
    edited.vehicle_type_code
  );
  const sheet = buildVerification(s as unknown as VerificationSource, properties, edits);

  // Checked here and not only on the screen. The button being enabled is not
  // evidence that it should have been: this endpoint is a POST like any other,
  // and the same computation that greys the button refuses the request.
  if (!sheet.ready) {
    return json(400, {
      error: sheet.invalid.length > 0
        ? `These edits could not be read, so they are not in force: ` +
          `${sheet.invalid.map((f) => f.label).join(", ")}. Correct them before verifying.`
        : reason ??
          `Not every field TecAssured asks for has a value yet: ` +
          `${sheet.missing.map((f) => f.label).join(", ")}.`,
      missing: sheet.missing.map((f) => ({ key: f.key, label: f.label })),
      invalid: sheet.invalid.map((f) => ({ key: f.key, label: f.label })),
      unmapped_properties: sheet.unmapped_properties,
    });
  }

  // A field that disagrees with the CRM deal does NOT stop a verification. Jim's
  // rule, and the right one: the person at the desk can see the machine and the
  // paperwork, so their figure is the one to rate on. What it does do is stay on
  // the record and on the screen until the deal is brought into line.

  const now = new Date().toISOString();

  // What the verifier saw, in full. This is the compliance record: it makes
  // "the price was built from bad data" a question with an answer.
  const snapshot = {
    verified_at: now,
    verified_by: verifiedBy,
    // The vehicle type as RATED, which on a corrected deal is not the CRM's.
    // Recording the CRM value here would make the snapshot disagree with the
    // required_properties list beside it, and the list is the one that was used.
    vehicle_type_code: edited.vehicle_type_code ?? null,
    required_properties: properties,
    fields: sheet.fields.map((f) => ({
      key: f.key,
      label: f.label,
      value: f.value,
      source: f.source,
      provider_property: f.provider_property,
      required: f.required,
    })),
    rating_inputs: ratingInputs(sheet),

    // Who changed what, from what, to what, and when. The compliance half of
    // making CRM fields editable: a price that was rated on a staff correction
    // must be answerable months later, by name.
    staff_edits: sheet.edited.map((f) => ({
      key: f.key,
      label: f.label,
      from: f.original,
      from_source: f.original_source,
      to: f.value,
      edited_by: f.edited_by,
      edited_at: f.edited_at,
      in_crm: f.in_crm,
      differs_from_crm: f.differs_from_crm,
    })),
    // What the CRM deal disagreed with at the moment this was verified.
    crm_mismatches: sheet.crm_mismatches,
    crm_warning: sheet.crm_warning,
  };

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({
      verification_state: "Verified",
      verified_at: now,
      verified_by: verifiedBy,
      verified_snapshot: snapshot,
    })
    .eq("id", s.id as string);

  if (error) return json(500, { error: error.message });

  // A fresh verification supersedes whatever was rated under the old inputs.
  await supabase
    .schema("fni")
    .from("rated_offers")
    .update({ out_of_date: true })
    .eq("session_id", s.id as string);

  const fresh = (await loadSession(supabase, s.id as string))!;
  return json(200, {
    ...(await sheetFor(supabase, fresh)),
    // The caller runs the rating. Kept separate so a verification is recorded
    // even if the provider is having a bad afternoon: the person did their part
    // and the record should say so.
    verified: true,
  });
}

// ── Handler ───────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const url = new URL(req.url);

  const presented =
    req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  if (!secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }

  const supabase = admin();

  try {
    if (req.method === "GET") {
      const sessionId = url.searchParams.get("session_id");
      if (!sessionId || !UUID_RE.test(sessionId)) {
        return json(400, { error: "A well-formed session_id is required" });
      }
      const s = await loadSession(supabase, sessionId);
      if (!s) return json(404, { error: "Session not found" });
      return json(200, await sheetFor(supabase, s));
    }

    if (req.method !== "POST") return json(405, { error: "GET or POST only" });

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: "A JSON body is required" });
    }

    const sessionId = body.session_id;
    if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
      return json(400, { error: "A well-formed session_id is required" });
    }

    const s = await loadSession(supabase, sessionId);
    if (!s) return json(404, { error: "Session not found" });

    const action = String(body.action ?? "");

    if (action === "save") {
      const entries = body.entries;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        return json(400, { error: "entries must be an object" });
      }
      // An edit with nobody's name on it is not a record of anything, and these
      // edits can now move a price. Same rule as verify.
      const who = typeof body.edited_by === "string" ? body.edited_by.trim() : "";
      if (who === "") {
        return json(400, { error: "edited_by is required: an edit names a person." });
      }
      return await save(supabase, s, entries as Record<string, unknown>, who);
    }

      if (action === "refresh") return await refresh(supabase, s);
    if (action === "planned_sale_date") return await setPlannedSaleDate(supabase, s, body.value);
    if (action.startsWith("party_")) {
      const who = typeof body.edited_by === "string" ? body.edited_by.trim() : "";
      if (who === "") return json(400, { error: "edited_by is required: an edit names a person." });
      return await partyAction(supabase, s, action, body, who);
    }
    if (action === "sale_date_keep_staff" || action === "sale_date_use_crm") {
      const who = typeof body.edited_by === "string" ? body.edited_by.trim() : "";
      if (who === "") return json(400, { error: "edited_by is required: an edit names a person." });
      return await saleDateAction(supabase, s, action, who);
    }
    if (action === "discard_edits") return await discardEdits(supabase, s);

    if (action === "verify") {
      const who = typeof body.verified_by === "string" ? body.verified_by.trim() : "";
      if (who === "") {
        // A verification with nobody's name on it is not a verification.
        return json(400, { error: "verified_by is required: a verification names a person." });
      }
      return await verify(supabase, s, who);
    }

    return json(400, {
      error:
        "action must be one of save, refresh, discard_edits, verify, planned_sale_date, " +
        "party_save, party_remove, party_restore, party_keep_staff, party_use_crm, " +
        "sale_date_keep_staff, sale_date_use_crm",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-session-verify error:", message);
    return json(500, { error: message });
  }
});
