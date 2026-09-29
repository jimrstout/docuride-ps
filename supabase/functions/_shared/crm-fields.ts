// _shared/crm-fields.ts
//
// The rating inputs the CRM owns, read from a Zoho DocuRide record.
//
// Its own module so a Node test can import it. The Edge Function entrypoints
// cannot be imported from the test suite -- they pull `serve` from deno.land and
// Node's loader will not fetch over https -- and this mapping is exactly the
// thing that most needs a test holding it beside fni-session-start's.

import { vtypeForBodyType } from "./vehicle-types.ts";

/**
 * The rating inputs the CRM owns, mapped from a Zoho record.
 *
 * Deliberately a subset of fni-session-start's mapSession: the columns that feed
 * a rate, plus the two that identify the deal on screen. A refresh is for
 * correcting what a rate is built from, and rewriting the buyer's name, street,
 * phone and email on the way past would be a much larger action than the button
 * says it is.
 *
 * test/verification-crm-parity.test.mjs asserts this agrees with mapSession on
 * every key both of them set, so the two cannot drift into disagreeing about
 * what a field means.
 */
export function crmRatingFields(record: Record<string, unknown>): Record<string, unknown> {
  const text = (v: unknown) => {
    if (v === null || v === undefined) return null;
    const t = String(v).trim();
    return t === "" ? null : t;
  };
  const num = (v: unknown) => {
    const t = text(v);
    if (t === null) return null;
    const n = parseFloat(t.replace(/[$,\s%]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const int = (v: unknown) => {
    const n = num(v);
    return n === null ? null : Math.round(n);
  };

  const saleDate = record.Sale_Date ?? null;
  const hasLienholder = !!text(record.Lienholder_Name);

  return {
    deal_number: text(record.Name),
    stock_number: text(record.Sold_1_Stock_Number),
    vin: text(record.Sold_1_VIN),
    unit_year: int(record.Sold_1_Year),
    unit_make: text(record.Sold_1_Make),
    unit_model: text(record.Sold_1_Model),
    condition: text(record.Sold_1_Condition) || null,
    vehicle_type_code: vtypeForBodyType(text(record.Sold_1_Body_Type)),
    odometer: int(record.Sold_1_Meter),

    sale_price: num(record.Sold_1_Vehicle_DSP),
    amount_financed: num(record.DC_Sold_1_Balance_Due),
    apr: num(record.TILA_APR),
    finance_term: int(record.TILA_Pmt1_Count),

    // ── The corrected finance columns ─────────────────────────────────────────
    // Refreshed here because the Verify sheet and the rate request now read the
    // term and rate through these, so a Refresh that left them alone would
    // re-pull the deal and still show yesterday's term. The derivation is
    // fni-session-get's derivePaymentBasis, which is where these three were
    // first filled in; SPEC_CORRECTIONS.md §1 is why they are the right ones.
    interest_rate: num(record.Interest_Rate),
    tila_amount_financed: num(record.TILA_Amount_Financed),
    finance_term_total:
      int(record.Term_Months) ??
      (int(record.TILA_Pmt1_Count) === null
        ? null
        : (int(record.TILA_Pmt1_Count) as number) + (int(record.TILA_Pmt2_Count) ?? 0)),
    // Shown on the Verify screen as Lender, and what finance_type below is
    // derived from, so the two cannot drift apart across a refresh.
    lienholder_name: text(record.Lienholder_Name),
    // The cash down agreed on the deal. Sold_1_Down_Payment, not
    // TILA_Down_Payment: on deals where the TILA box is filled it is this plus
    // any positive trade-in equity, which is a different number. Shown on
    // Verify, read only, and not a rating input.
    agreed_down_payment: num(record.Sold_1_Down_Payment),

    finance_type: hasLienholder ? "Loan" : "Cash",
    sale_date: saleDate,
    in_service_date: saleDate,

    buyer_city: text(record.Buyer_City),
    buyer_state: text(record.Buyer_State),
    buyer_zip: text(record.Buyer_ZIP),
  };
}
