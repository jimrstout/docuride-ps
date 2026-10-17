// Multi-provider Part 2: adapters and normalized offers.
//
// Every provider's offers become NormalizedOffers, and groupOffers folds them
// into the families the planner renders. For TecAssured the result must be the
// same, to the byte, as before adapters existed: a Parkersburg deal presents
// the same products.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { normalizeOffer, allTiers } from "../supabase/functions/_shared/planner-offers.ts";
import { groupOffers } from "../supabase/functions/_shared/normalized-offer.ts";
import { tecAssuredOffers } from "../supabase/functions/_shared/adapters/tecassured-offers.ts";
import {
  priceSheetRequiredInputs,
  rateFromSheet,
  whyNotEligible,
} from "../supabase/functions/_shared/adapters/price-sheet.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const QUOTE = JSON.parse(src("./fixtures/tecassured-rate-utv-3-306.json"));
const RA = { id: "prov-ra", name: "Riders Advantage" };
const BRP = { id: "prov-brp", name: "BRP" };
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

test("a TecAssured quote groups into exactly what it did before adapters", () => {
  // Hashes of normalizeOffer's output on this quote, taken from the code before
  // Part 2. Any change to a family, tier, rate, order or raw object moves them.
  assert.equal(sha(normalizeOffer(QUOTE, { id: "prov-1", name: "Riders Advantage" })), "f4c1f6113c9a0a5d021f707ec6c3b0e43f9a7bc2c9d2d122d33f6ab9f66bf9d9");
  assert.equal(sha(normalizeOffer(QUOTE, null)), "10eef16206e9cb050e650db61f5ec0b695706a9e591d294c826ef87f580e74b3");
});

test("one normalized offer per buyable rate, eleven products, five decisions", () => {
  const offers = tecAssuredOffers(QUOTE, RA);
  assert.equal(offers.length, 41);
  assert.equal(new Set(offers.map((o) => o.product_code)).size, 11);
  const families = groupOffers(offers);
  assert.deepEqual(families.map((f) => f.family_code), ["BAT", "PPM", "TAW", "THP", "VSA"]);
  assert.equal(allTiers(families).length, 11);
  for (const o of offers) {
    assert.equal(o.provider_id, "prov-ra");
    assert.equal(o.rate_key, o.source.rate.unique);
    // TecAssured's maximum is cost plus its markup, as offered_price always was.
    assert.equal(o.maximum_price, o.dealer_cost + o.provider_markup);
  }
});

test("two providers' families with the same code stay two decisions", () => {
  const offer = (provider, code) => ({
    provider_id: provider.id, provider_name: provider.name, product_id: null,
    product_code: code, product_name: code, category: "Theft", family_code: "THEFT",
    plan: null, term_months: 36, term_miles: null, deductible: 0, deductible_label: null,
    disappearing_deductible: false, dealer_cost: 100, provider_markup: 0,
    suggested_retail: null, maximum_price: null, options: [], eligibility_notes: [],
    rate_key: `${provider.id}-${code}`, source: { product: {}, rate: {} },
  });
  const families = groupOffers([offer(RA, "A"), offer(BRP, "A"), offer(BRP, "B")]);
  assert.equal(families.length, 2);
  assert.deepEqual(families.map((f) => [f.provider_name, f.tiers.length]), [["BRP", 2], ["Riders Advantage", 1]]);
});

// ── Price sheets ─────────────────────────────────────────────────────────

const row = (over = {}) => ({
  id: "row-1", product_code: "BRP-B3", product_name: "BRP Extended Service Terms, 3 years",
  family_code: "BEST", plan: "3 years", category: "Mechanical Protection",
  makes: ["Can-Am"], model_contains: [], year_min: null, year_max: null,
  vehicle_types: [], conditions: [], max_age_years: null, max_odometer: null,
  engine_cc_min: null, engine_cc_max: null, max_months_in_service: null,
  term_months: 36, term_miles: null, deductible: 50, dealer_cost: 410,
  suggested_retail: 699, options: [], flagged: false, ...over,
});

const deal = {
  store_id: "store-pkb", make: "Can-Am", model: "Defender XT HD7", year: 2026,
  condition: "New", vehicle_type_code: "UTV", odometer: 1, engine_cc: 650,
  sale_date: "2026-10-16", in_service_date: "2026-10-16",
};

test("a sheet asks only for what its rows test", () => {
  assert.deepEqual(priceSheetRequiredInputs([row()]), ["make"]);
  assert.deepEqual(
    priceSheetRequiredInputs([row({ conditions: ["New"], engine_cc_min: 500 }), row({ max_age_years: 3 })]),
    ["make", "year", "new.used", "engine.ccs", "sale.date"]
  );
  // A flagged row is never offered, so it asks for nothing.
  assert.deepEqual(priceSheetRequiredInputs([row({ flagged: true, max_odometer: 500 })]), ["make"]);
});

test("eligibility is checked field by field, in plain English", () => {
  assert.equal(whyNotEligible(row(), deal), null);
  assert.equal(whyNotEligible(row(), { ...deal, make: "can-am " }), null);
  assert.match(whyNotEligible(row(), { ...deal, make: "Polaris" }), /It is for Can-Am, and this is a Polaris\./);
  assert.match(whyNotEligible(row({ conditions: ["Used"] }), deal), /Used units/);
  assert.match(whyNotEligible(row({ engine_cc_max: 570 }), deal), /up to 570 cc/);
  assert.match(whyNotEligible(row({ max_odometer: 500 }), { ...deal, odometer: null }), /500 or fewer/);
  assert.equal(whyNotEligible(row({ model_contains: ["defender"] }), deal), null);
  assert.match(whyNotEligible(row({ model_contains: ["Maverick"] }), deal), /Maverick/);
  assert.equal(whyNotEligible(row({ max_age_years: 0 }), deal), null);
  assert.match(whyNotEligible(row({ max_age_years: 0 }), { ...deal, year: 2025 }), /0 model years/);
});

test("no published sheet fails with the provider's name", () => {
  const r = rateFromSheet(BRP, null, [row()], deal);
  assert.deepEqual(r, { state: "Failed", reason: "No price sheet published for BRP." });
});

test("a published sheet offers the rows that fit, and only unflagged ones", () => {
  const sheet = { id: "sheet-1", name: "BRP 2026 rates" };
  const r = rateFromSheet(BRP, sheet, [row(), row({ id: "row-2", makes: ["Sea-Doo"] }), row({ id: "row-3", flagged: true })], deal);
  assert.equal(r.state, "Rated");
  assert.deepEqual(r.offers.map((o) => o.rate_key), ["row-1"]);
  const o = r.offers[0];
  assert.equal(o.provider_name, "BRP");
  assert.equal(o.dealer_cost, 410);
  assert.equal(o.suggested_retail, 699);
  assert.equal(o.maximum_price, null);
  assert.equal(o.family_code, "BEST");
  assert.equal(o.deductible_label, "$50 deductible");

  const none = rateFromSheet(BRP, sheet, [row({ makes: ["Ski-Doo"] })], deal);
  assert.equal(none.state, "Not Offered");
  assert.equal(none.reason, `Nothing on BRP's sheet "BRP 2026 rates" fits this unit.`);
});

test("the TecAssured adapter keeps rate-vehicle's wording and request", () => {
  const adapter = src("../supabase/functions/_shared/adapters/tecassured.ts");
  assert.match(adapter, /buildRateRequest\(props, rateSource as unknown as RateSource/);
  assert.match(adapter, /TecAssured refused the rate request: \$\{err\.trim\(\)\}/);
  assert.match(adapter, /has no rateable products for vehicle type/);
  assert.match(adapter, /tecAssuredOffers\(response, provider\)/);
});
