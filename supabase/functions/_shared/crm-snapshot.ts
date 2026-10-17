// _shared/crm-snapshot.ts
//
// The CRM fields a planning session may keep, and nothing else.
//
// fni.sessions.raw_snapshot used to be the whole Zoho DocuRide record: over 300
// fields, among them the buyer's and co-buyer's Social Security number, date of
// birth, driver's license number and scan, credit score, credit application,
// employer and proof of income. The menu reads none of those. A real deal
// (14957) proved they were all there.
//
// So the snapshot is now built from an allow list. A field is kept only when it
// is named below, which means a sensitive field added to the CRM next year is
// left out without anybody having to remember it exists. Never turn this into a
// list of fields to drop: that is the design that failed.
//
// Every field here is one fni-session-start maps into a session column, or one
// fni-session-get reads back to recover the payment math. Nothing on this list
// is stored that is not already on the session row in its own column; the
// snapshot is the record of what the CRM said when the session was made.
//
// Adding a field: add it here, say in the comment which code reads it, and the
// test in test/crm-snapshot-allow-list.test.mjs will check it is not one of the
// sensitive kinds.

/** The Zoho DocuRide fields a session keeps in raw_snapshot. */
export const MENU_CRM_FIELDS: readonly string[] = [
  // Which record, and which store. Read by fni-session-start.
  "id",
  "Name",
  "Store_Location",
  "Modified_Time",

  // The vehicle. mapSession and crmRatingFields.
  "Sold_1_Stock_Number",
  "Sold_1_VIN",
  "Sold_1_Year",
  "Sold_1_Make",
  "Sold_1_Model",
  "Sold_1_Condition",
  "Sold_1_Body_Type",
  "Sold_1_Meter",
  "Sale_Date",

  // The money. mapSession and crmRatingFields, and the payment math
  // fni-session-get recovers from the snapshot (derivePaymentBasis).
  "Sold_1_Vehicle_DSP",
  "Sold_1_Down_Payment",
  "DC_Sold_1_Balance_Due",
  "TILA_APR",
  "TILA_Pmt1_Count",
  "TILA_Pmt1_Amount",
  "TILA_Pmt2_Count",
  "TILA_Amount_Financed",
  "Interest_Rate",
  "Term_Months",

  // The buyer, as the contract needs them. mapSession.
  "Buyer_Type",
  "Buyer_Display_Name",
  "Buyer_First_Name",
  "Buyer_Last_Name",
  "Buyer_Street_Address",
  "Buyer_City",
  "Buyer_State",
  "Buyer_ZIP",
  "Buyer_Phone",
  "Email",

  // The co-buyer, the same way. mapSession.
  "Co_Buyer_Type",
  "Co_Buyer_Display_Name",
  "Co_Buyer_First_Name",
  "Co_Buyer_Last_Name",
  "Co_Buyer_Street_Address",
  "Co_Buyer_City",
  "Co_Buyer_State",
  "Co_Buyer_ZIP",
  "Co_Buyer_Phone",
  "Co_Buyer_Email",

  // The lender. mapSession and crmRatingFields.
  "Lienholder_Name",
  "Lienholder_Street",
  "Lienholder_City_State_ZIP",
  "Lienholder_Phone",
];

/**
 * The part of a CRM record a session may keep: the allowed fields that are
 * present, and nothing else.
 */
export function menuSnapshot(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of MENU_CRM_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) out[key] = record[key];
  }
  return out;
}
