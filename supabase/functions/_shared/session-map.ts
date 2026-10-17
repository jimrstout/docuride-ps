// _shared/session-map.ts
//
// A Zoho DocuRide record turned into a new fni.sessions row.
//
// Moved here from fni-session-start so a Node test can build a session from a
// record and check what ends up in it. The entrypoint cannot be imported from
// the test suite: it pulls `serve` from deno.land.

import type { ZohoRecord } from "./zoho.ts";
import { vtypeForBodyType } from "./vehicle-types.ts";
import { crmRatingFields } from "./crm-fields.ts";
import { menuSnapshot } from "./crm-snapshot.ts";

// ─── Field helpers ───────────────────────────────────────────────────────

export function text(v: unknown): string | null {
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

export function mapSession(
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
    agreed_down_payment: crm.agreed_down_payment,
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

    // Only the fields on the allow list in _shared/crm-snapshot.ts. Never the
    // whole record: it carries SSNs, dates of birth, license numbers and credit
    // scores the menu has no use for.
    raw_snapshot: menuSnapshot(record),
  };
}
