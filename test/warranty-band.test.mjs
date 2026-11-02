// Plans sold by remaining factory warranty: only the band holding the months
// the deal was rated with appears anywhere (_shared/warranty-band.ts).
//
// Deal 15063, rated with 12 months remaining, showed "Mechanical Protection,
// Premium Plus 25-36" in Platinum: the provider returns every band, and its
// own descriptions say what they key off ("... 13-24 Months Warranty
// Remaining"). Mock data only; the labels follow the provider's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { familiesFromRows } from "../supabase/functions/_shared/rating-summary.ts";
import { bandHolds, bandRefusal, warrantyBand } from "../supabase/functions/_shared/warranty-band.ts";
import { changedInputs, ratingInputs } from "../supabase/functions/_shared/verification.ts";

const P = "prov-1";
const product = (unique, ptype, label) => ({
  unique, ptype, label,
  rates: [{ unique: `${unique}-r`, termMonths: 48, termMiles: 0, dealerCost: { amount: 400, currency: "USD" }, providerMarkup: { adjustment: { amount: 0 } }, dealerDeduct: { amount: 0 }, attributes: {}, options: [] }],
});
const PRODUCTS = [
  product("PP-1", "VSA", "NEW ATV/UTV PREMIUM PLUS 1-12 - SAMPLE PREMIUM PLUS"),
  product("PP-2", "VSA", "NEW ATV/UTV PREMIUM PLUS 13-24 - SAMPLE PREMIUM PLUS"),
  product("PP-3", "VSA", "NEW ATV/UTV PREMIUM PLUS 25-36 - SAMPLE PREMIUM PLUS"),
  product("CP-1", "VSA", "NEW ATV/UTV CARE PLUS 1-12 - SAMPLE CARE PLUS COVERAGE"),
  product("PM-1", "PPM", "NEW BRONZE ATV/OFF-ROAD MC - SAMPLE PPM"),
  product("GAP-1", "GAP", "POWERSPORTS GAP 150% - SAMPLE GAP"),
];
const rowFor = (months) => ({
  provider_id: P, state: "Rated", product_count: PRODUCTS.length, rated_at: "2026-11-02T22:57:31Z", error_detail: null, out_of_date: false,
  provider: { id: P, name: "Sample", kind: "API", adapter: "TecAssured" },
  request_payload: months === null ? {} : { remainingMWM: String(months) },
  response_payload: { quote: { vehicles: [{ products: PRODUCTS }] } },
});
const offered = (months) => familiesFromRows([rowFor(months)]).flatMap((f) => f.tiers.map((t) => t.product_code)).sort();

test("12 months shows only the 1-12 bands", () => {
  assert.deepEqual(offered(12), ["CP-1", "GAP-1", "PM-1", "PP-1"]);
});

test("13 months shows only 13-24", () => {
  assert.deepEqual(offered(13), ["GAP-1", "PM-1", "PP-2"]);
});

test("36 months shows only 25-36", () => {
  assert.deepEqual(offered(36), ["GAP-1", "PM-1", "PP-3"]);
});

test("0 months shows no band at all; products without a band are untouched", () => {
  assert.deepEqual(offered(0), ["GAP-1", "PM-1"]);
  // A rating with no warranty months shows no band either.
  assert.deepEqual(offered(null), ["GAP-1", "PM-1"]);
});

test("the band is read from the label, Mechanical Protection only", () => {
  assert.deepEqual(warrantyBand("NEW ATV/UTV PREMIUM PLUS 13-24 - RIDERS ADVANTAGE PREMIUM PLUS", "VSA"), { from: 13, to: 24 });
  assert.equal(warrantyBand("USED ATV/UTV CARE - RIDERS ADVANTAGE CARE COVERAGE", "VSA"), null);
  assert.equal(warrantyBand("POWERSPORTS GAP 150% - RIDERS ADVANTAGE GAP", "GAP"), null);
  assert.equal(bandHolds({ from: 1, to: 12 }, 12), true);
  assert.equal(bandHolds({ from: 1, to: 12 }, 13), false);
});

test("Submit refuses a band that does not hold the rated months, before anything is sent", () => {
  assert.equal(
    bandRefusal("Mechanical Protection, Premium Plus 25-36", { from: 25, to: 36 }, 12),
    "Mechanical Protection, Premium Plus 25-36 is for 25 to 36 months of factory warranty remaining, and this deal was rated with 12, so it cannot be sent."
  );
  const submit = readFileSync(new URL("../supabase/functions/fni-contract-submit/index.ts", import.meta.url), "utf8");
  const check = submit.indexOf("const wrongBand = resolved");
  assert.ok(check > 0 && check < submit.indexOf("await client.submitContractDetailed(submitPayload)"));
});

test("changing warranty months requires Rate again", () => {
  // Warranty is a rating input: a change un-verifies the deal and marks its
  // rating out of date (fni-session-verify unverifyIfInputsMoved).
  const sheet = (w) => ({ fields: [
    { key: "warranty", label: "Factory warranty remaining", value: w, provider_property: "warranty" },
    { key: "deal_number", label: "Deal #", value: "1", provider_property: null },
  ] });
  assert.deepEqual(changedInputs(ratingInputs(sheet("12")), ratingInputs(sheet("13"))), ["warranty"]);
  const verify = readFileSync(new URL("../supabase/functions/fni-session-verify/index.ts", import.meta.url), "utf8");
  assert.match(verify, /\.from\("rated_offers"\)\s*\.update\(\{ out_of_date: true \}\)/);
});
