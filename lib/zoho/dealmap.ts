/*
 * Zoho DocuRide record -> public.deals row.
 *
 * The DocuRide module has 289 fields. Rather than 289 columns (the ceiling
 * that drove this migration in the first place), we promote the ~20 fields we
 * filter, sort or report on and group the rest into jsonb by prefix:
 *
 *   Dealership_*      -> dealership
 *   TILA_*            -> tila
 *   Sold_1_*          -> financials
 *   Trade_1..3_*      -> trades (array, empty trades dropped)
 *
 * The record also lands in `raw`, minus the identity fields listed in
 * REDACTED_FIELDS below, so a field we did not think to promote is still
 * queryable via the gin index and a later migration can promote it without a
 * re-sync.
 *
 * Zoho field API names are case-sensitive (CLAUDE.md). Every name below was
 * verified against getFields for the DocuRide module.
 */

import type { ZohoRecord } from "./client.js";

export interface DealRow {
  tenant_id: string;
  zoho_id: string;
  zoho_modified_time: string | null;
  deal_number: string | null;
  store_location: string | null;
  deal_status: string | null;
  esign_status: string | null;
  titlework_status: string | null;
  archive_status: string | null;
  sale_class: string | null;
  sale_date: string | null;
  buyer_display_name: string | null;
  buyer_last_name: string | null;
  cobuyer_display_name: string | null;
  salesperson: string | null;
  stock_number: string | null;
  vin: string | null;
  unit_year: string | null;
  unit_make: string | null;
  unit_model: string | null;
  reynolds_documents: string | null;
  dealership: Record<string, unknown>;
  tila: Record<string, unknown>;
  financials: Record<string, unknown>;
  trades: Record<string, unknown>[];
  raw: ZohoRecord;
}

/**
 * Zoho field API name -> promoted deals column.
 *
 * Single source of truth: mapDeal writes these columns, and /api/deals/:id
 * reads this map so a web write to a promoted field updates the column as well
 * as `raw`, instead of the two drifting apart.
 */
export const PROMOTED_COLUMNS: Record<string, keyof DealRow> = {
  Name: "deal_number",
  Store_Location: "store_location",
  Deal_Status: "deal_status",
  eSign_Status: "esign_status",
  Titlework_Status: "titlework_status",
  Archive_Status: "archive_status",
  Sale_Class: "sale_class",
  Sale_Date: "sale_date",
  Buyer_Display_Name: "buyer_display_name",
  Buyer_Last_Name: "buyer_last_name",
  Co_Buyer_Display_Name: "cobuyer_display_name",
  Salesperson: "salesperson",
  Sold_1_Stock_Number: "stock_number",
  Sold_1_VIN: "vin",
  Sold_1_Year: "unit_year",
  Sold_1_Make: "unit_make",
  Sold_1_Model: "unit_model",
  Reynolds_Documents: "reynolds_documents",
};

/**
 * Fields dropped on the way into `raw`.
 *
 * `raw` exists so an "off a penny" argument becomes a diff, and none of these
 * are money fields — but deals_read grants select on the whole row to every
 * user in the tenant, so mirroring them would put SSNs and dates of birth in
 * front of anyone who can log in. Keeping them out of Postgres entirely is
 * cheaper than guarding them once they are in (MIGRATION_PATH.md §6).
 *
 * Zoho remains the system of record for these until there is a table with
 * tighter RLS to hold them. The DL_Upload fields are attachment references,
 * which resolve to a scan of the licence, so they go too. Credit scores are
 * FCRA-regulated and nothing in Phase 1 reads them.
 */
const REDACTED_FIELDS = new Set([
  "Buyer_SSN",
  "Co_Buyer_SSN",
  "Buyer_DOB",
  "Co_Buyer_DOB",
  "Buyer_DL_Number",
  "Co_Buyer_DL_Number",
  "Buyer_DL_Upload",
  "Co_Buyer_DL_Upload",
  "Buyer_Credit_Score",
  "Co_Buyer_Credit_Score",
]);

function redact(record: ZohoRecord): ZohoRecord {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!REDACTED_FIELDS.has(k)) out[k] = v;
  }
  return out as ZohoRecord;
}

// ---------- coercion ----------

/**
 * Zoho returns absent values as null, and cleared text fields as "".
 * Both mean "no value" — collapse them so we do not write empty strings into
 * columns the reports then have to special-case.
 */
function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Lookups and owner objects arrive as {id, name}; keep the human-readable side.
  if (typeof v === "object") {
    const name = (v as { name?: unknown }).name;
    return typeof name === "string" && name.trim() !== "" ? name : null;
  }
  return null;
}

/** Postgres rejects "" for date/timestamptz, so empty must become null. */
function temporal(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Collect Zoho fields sharing a prefix into an object, prefix stripped. */
function group(record: ZohoRecord, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k.startsWith(prefix) && v !== null && v !== undefined && v !== "") {
      out[k.slice(prefix.length)] = v;
    }
  }
  return out;
}

// ---------- mapping ----------

const TRADE_SLOTS = [1, 2, 3] as const;

function mapTrades(record: ZohoRecord): Record<string, unknown>[] {
  const trades: Record<string, unknown>[] = [];
  for (const slot of TRADE_SLOTS) {
    const fields = group(record, `Trade_${slot}_`);
    // A trade slot with no populated field is an unused slot, not a trade.
    if (Object.keys(fields).length === 0) continue;
    trades.push({ slot, ...fields });
  }
  return trades;
}

export function mapDeal(record: ZohoRecord, tenantId: string): DealRow {
  return {
    tenant_id: tenantId,
    zoho_id: String(record.id),
    zoho_modified_time: temporal(record.Modified_Time),

    deal_number: text(record.Name),
    store_location: text(record.Store_Location),
    deal_status: text(record.Deal_Status),
    esign_status: text(record.eSign_Status),
    titlework_status: text(record.Titlework_Status),
    archive_status: text(record.Archive_Status),
    sale_class: text(record.Sale_Class),
    sale_date: temporal(record.Sale_Date),
    buyer_display_name: text(record.Buyer_Display_Name),
    buyer_last_name: text(record.Buyer_Last_Name),
    cobuyer_display_name: text(record.Co_Buyer_Display_Name),
    salesperson: text(record.Salesperson),
    stock_number: text(record.Sold_1_Stock_Number),
    vin: text(record.Sold_1_VIN),
    // Sold_1_Year is an integer in Zoho; unit_year is text here so a bike
    // year and a VIN-derived year compare the same way.
    unit_year: text(record.Sold_1_Year),
    unit_make: text(record.Sold_1_Make),
    unit_model: text(record.Sold_1_Model),
    reynolds_documents: text(record.Reynolds_Documents),

    dealership: group(record, "Dealership_"),
    tila: group(record, "TILA_"),
    financials: group(record, "Sold_1_"),
    trades: mapTrades(record),

    raw: redact(record),
  };
}
