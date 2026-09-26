// The two CRM mappings must agree.
//
// fni-session-start's mapSession builds a whole session from a Zoho record.
// fni-session-verify's crmRatingFields re-reads the subset that feeds a rate,
// for the Refresh button. Two mappings of the same fields is a drift risk with a
// nasty failure mode: Refresh would quietly move a value to something the
// session was never created with, and the next rate would be built on it.
//
// So this holds them side by side against one record and asserts they produce
// the same value for every column both of them set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crmRatingFields } from "../supabase/functions/_shared/crm-fields.ts";

// fni-session-start cannot be imported: it pulls `serve` from deno.land and
// Node's loader will not fetch over https. So mapSession is compared
// structurally, on the one thing that can silently go wrong -- which Zoho field
// feeds which column. A value-level test of that function belongs to Deno.
const SESSION_START = readFileSync(
  new URL("../supabase/functions/fni-session-start/index.ts", import.meta.url),
  "utf8"
);

/** The `record.X` a given session column is assigned from, per mapSession. */
function zohoFieldFor(column) {
  const m = SESSION_START.match(
    new RegExp(`^\\s*${column}:\\s*[^,\\n]*record\\.([A-Za-z0-9_]+)`, "m")
  );
  return m ? m[1] : null;
}

/** A DocuRide record with every field either mapping reads, plausibly filled. */
const record = {
  id: "5566778899",
  Name: "14132",
  Sold_1_Stock_Number: "30111",
  Sold_1_VIN: "3JBUKAJ44TK002241",
  Sold_1_Year: "2026",
  Sold_1_Make: "Can-Am",
  Sold_1_Model: "Defender XT HD7",
  Sold_1_Condition: "New",
  Sold_1_Body_Type: "SxS",
  Sold_1_Meter: "1",
  Sold_1_Vehicle_DSP: "16,899.00",
  DC_Sold_1_Balance_Due: "19,764.64",
  TILA_APR: "8.99",
  TILA_Pmt1_Count: "60",
  TILA_Pmt1_Amount: "402.11",
  Lienholder_Name: "",
  Sale_Date: "2026-09-26",
  Buyer_City: "Barboursville",
  Buyer_State: "WV",
  Buyer_ZIP: "25504",
};

/**
 * Which Zoho field each shared column reads. Written out rather than derived,
 * so that changing one side does not silently change what this test asserts:
 * a rename in either mapping has to be acknowledged here.
 */
const SHARED_COLUMNS = {
  deal_number: "Name",
  stock_number: "Sold_1_Stock_Number",
  vin: "Sold_1_VIN",
  unit_year: "Sold_1_Year",
  unit_make: "Sold_1_Make",
  unit_model: "Sold_1_Model",
  condition: "Sold_1_Condition",
  odometer: "Sold_1_Meter",
  sale_price: "Sold_1_Vehicle_DSP",
  amount_financed: "DC_Sold_1_Balance_Due",
  apr: "TILA_APR",
  finance_term: "TILA_Pmt1_Count",
  buyer_city: "Buyer_City",
  buyer_state: "Buyer_State",
  buyer_zip: "Buyer_ZIP",
};

test("both mappings read the same Zoho field for every shared column", () => {
  const b = crmRatingFields(record);

  for (const [column, zohoField] of Object.entries(SHARED_COLUMNS)) {
    assert.ok(column in b, `crmRatingFields must set ${column}`);
    assert.equal(
      zohoFieldFor(column),
      zohoField,
      `mapSession no longer reads record.${zohoField} for ${column}`
    );
  }
});

test("the shared columns produce the values that record implies", () => {
  const b = crmRatingFields(record);
  assert.equal(b.deal_number, "14132");
  assert.equal(b.vin, "3JBUKAJ44TK002241");
  assert.equal(b.unit_year, 2026);
  assert.equal(b.condition, "New");
  assert.equal(b.odometer, 1);
  // Display strings with commas, as Zoho sends them.
  assert.equal(b.sale_price, 16899);
  assert.equal(b.amount_financed, 19764.64);
  assert.equal(b.apr, 8.99);
  assert.equal(b.finance_term, 60);
  assert.equal(b.sale_date, "2026-09-26");
  assert.equal(b.in_service_date, "2026-09-26");
});

test("the refresh subset is a subset, and leaves the buyer's person alone", () => {
  const b = crmRatingFields(record);

  // Refresh re-pulls what a rate is built from. Rewriting the buyer's name,
  // street, phone or email on the way past would be a much larger action than
  // the button says it is.
  for (const forbidden of [
    "buyer_first_name", "buyer_last_name", "buyer_display_name",
    "buyer_address", "buyer_phone", "buyer_email",
    "cobuyer_first_name", "cobuyer_display_name",
    "status", "is_test", "tenant_id", "store_id", "verification_state",
  ]) {
    assert.ok(!(forbidden in b), `${forbidden} must not be rewritten by Refresh`);
  }
});

test("a lienholder is what makes a deal financed, in both mappings", () => {
  assert.equal(crmRatingFields(record).finance_type, "Cash");
  assert.equal(crmRatingFields({ ...record, Lienholder_Name: "Test Finance Co" }).finance_type, "Loan");

  // The same test, in the same words, on the other side.
  assert.match(
    SESSION_START,
    /hasLienholder\s*=\s*!!text\(record\.Lienholder_Name\)/,
    "mapSession no longer derives the deal type from Lienholder_Name"
  );
  assert.match(SESSION_START, /hasLienholder\s*\?\s*"Loan"\s*:\s*"Cash"/);
});

test("the body type becomes the vehicle type through the one shared map", () => {
  assert.equal(crmRatingFields(record).vehicle_type_code, "UTV");
  assert.equal(crmRatingFields({ ...record, Sold_1_Body_Type: "Trailer" }).vehicle_type_code, null);

  // Both call the same function on the same field, so there is one mapping and
  // not two that happen to agree today.
  assert.match(SESSION_START, /vtypeForBodyType\(bodyType\)/);
  assert.match(SESSION_START, /bodyType\s*=\s*text\(record\.Sold_1_Body_Type\)/);
});
