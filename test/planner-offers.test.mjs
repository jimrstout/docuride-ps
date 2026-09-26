// Turning a real TecAssured quote into families, tiers and rates.
//
// The fixture is the verbatim response from the QA server for dealer 3-306,
// fake buyer data only. It replaces test/fixtures/rated-offer.mjs, which was
// written before credentials existed, said UNCONFIRMED at the top, and guessed
// the shape wrong in the two ways these tests now pin down: where the products
// live, and that a product has many rates rather than one price.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  allTiers,
  findRate,
  normalizeOffer,
} from "../supabase/functions/_shared/planner-offers.ts";

const QUOTE = JSON.parse(
  readFileSync(new URL("./fixtures/tecassured-rate-utv-3-306.json", import.meta.url), "utf8")
);

const families = () => normalizeOffer(QUOTE);
const family = (code) => families().find((f) => f.family_code === code);
const tier = (code) => allTiers(families()).find((t) => t.product_code === code);

// ── Eleven products, five decisions ──────────────────────────────────────

test("products are grouped into families by ptype", () => {
  assert.deepEqual(families().map((f) => f.family_code), ["BAT", "PPM", "TAW", "THP", "VSA"]);
  assert.equal(allTiers(families()).length, 11);
});

test("the four PPM tiers are one family, not four products", () => {
  // Platinum, Gold, Silver and Bronze are tiers of mechanical protection. The
  // old model would have asked a customer to include or decline each of them.
  assert.deepEqual(
    family("PPM").tiers.map((t) => t.product_code),
    ["66_7", "78_7", "72_7", "84_7"]
  );
});

test("tiers are ordered cheapest first", () => {
  // Bronze 371, Silver 725, Gold 910, Platinum 1094. A tier list reads up.
  assert.deepEqual(
    family("PPM").tiers.map((t) => Math.min(...t.rates.map((r) => r.offered_price))),
    [371, 725, 910, 1094]
  );
});

test("a single-tier family still comes back as a family", () => {
  // Tire & Wheel is alone. The screen just has no tier choice on it.
  assert.equal(family("TAW").tiers.length, 1);
  assert.equal(family("TAW").tiers[0].product_name, "RIDER'S ADVANTAGE T&W OFF-ROAD - RIDERS ADVANTAGE TIRE & WHEEL");
});

test("a tier names itself from label, ptype and unique", () => {
  const t = tier("84_7");
  assert.equal(t.product_name, "USED PLATINUM UTV (Side by Side) - RIDERS ADVANTAGE PPM");
  assert.equal(t.product_type, "PPM");
  assert.equal(t.product_code, "84_7");
});

// ── Rates ────────────────────────────────────────────────────────────────

test("a product carries every rate it was offered at", () => {
  assert.deepEqual(tier("84_7").rates.map((r) => r.term_months), [36, 48]);
  assert.equal(tier("16_3").rates.length, 12);
  assert.equal(tier("754_6").rates.length, 1);
  assert.equal(allTiers(families()).reduce((n, t) => n + t.rates.length, 0), 41);
});

test("rates read shortest first, then smallest deductible", () => {
  // Twelve rates is four lengths times three deductibles, not twelve unrelated
  // things, and this is the order a customer should meet them in.
  const first3 = tier("16_3").rates.slice(0, 3);
  assert.deepEqual(first3.map((r) => r.term_months), [12, 12, 12]);
  assert.deepEqual(first3.map((r) => r.deductible), [0, 50, 100]);
});

test("the deductible carries the provider's own wording", () => {
  const byCode = new Map(tier("16_3").rates.map((r) => [r.rate_unique_id, r]));
  assert.equal(byCode.get("1898-5").deductible_code, "0 Ded");
  assert.equal(byCode.get("1898-7").deductible_code, "50 Ded");
  assert.equal(byCode.get("1898-6").deductible_code, "100 Dis Ded");
});

test("only the DIS rates are disappearing deductibles", () => {
  // This is what decides whether the dealer group sentence is shown at all.
  const byCode = new Map(tier("16_3").rates.map((r) => [r.rate_unique_id, r]));
  assert.equal(byCode.get("1898-6").disappearing_deductible, true);
  assert.equal(byCode.get("1898-5").disappearing_deductible, false);
  assert.equal(byCode.get("1898-7").disappearing_deductible, false);
});

test("mileage is zero on every powersports rate", () => {
  // Carried through for an AUTO quote, and expected to be omitted from the
  // interface when falsy. "0 miles" tells a customer nothing.
  for (const t of allTiers(families())) {
    for (const r of t.rates) assert.equal(r.term_miles, 0);
  }
});

// ── Money ────────────────────────────────────────────────────────────────

test("the price cap is dealer cost plus the provider's own markup", () => {
  // The provider rejects a submit above it, naming this figure.
  const r = tier("84_7").rates.find((x) => x.rate_unique_id === "2192");
  assert.equal(r.dealer_cost, 1044);
  assert.equal(r.provider_markup, 50);
  assert.equal(r.offered_price, 1094);
});

test("a family with no provider markup prices at cost", () => {
  const r = tier("754_6").rates[0];
  assert.equal(r.dealer_cost, 115);
  assert.equal(r.provider_markup, 0);
  assert.equal(r.offered_price, 115);
});

// ── Options ──────────────────────────────────────────────────────────────

test("options hang off the rate, with their cost and whether they are a choice", () => {
  const r = tier("16_3").rates[0];
  const byCode = new Map(r.options.map((o) => [o.code, o]));
  assert.equal(byCode.get("Trailer").label, "Trailer Package");
  assert.equal(byCode.get("Trailer").cost_delta, 75);
  assert.equal(byCode.get("Trailer").mandatory, false);
  assert.equal(byCode.get("HVAC").cost_delta, 125);
});

test("a mandatory option is marked as one", () => {
  const r = tier("86_3").rates.find((x) => x.rate_unique_id === "2210-5");
  const svc = r.options.find((o) => o.code === "Service_Drive");
  assert.equal(svc.mandatory, true);
});

test("a negative option is carried as negative", () => {
  // GPS EQUIPPED takes 50 off theft cover. Clamping it to zero would overcharge.
  const r = tier("24_5").rates[0];
  assert.equal(r.options.find((o) => o.code === "GPS").cost_delta, -50);
});

// ── Envelopes and edges ──────────────────────────────────────────────────

test("a payload with or without the outer quote key both work", () => {
  const inner = { vehicles: QUOTE.quote.vehicles };
  assert.equal(normalizeOffer(inner).length, 5);
});

test("the shapes the old version looked for return nothing, honestly", () => {
  // A top-level products array is not what a quote looks like. Returning [] for
  // it is correct; the bug was that a REAL quote also returned [].
  assert.deepEqual(normalizeOffer({ products: [{ unique: "x" }] }), []);
  assert.deepEqual(normalizeOffer(null), []);
  assert.deepEqual(normalizeOffer({}), []);
});

test("a product with no rates is dropped", () => {
  const stripped = {
    quote: { vehicles: [{ products: [{ unique: "x", ptype: "PPM", label: "X", rates: [] }] }] },
  };
  assert.deepEqual(normalizeOffer(stripped), []);
});

test("a rate can be found by its id wherever it sits", () => {
  const hit = findRate(families(), "2210-5");
  assert.equal(hit.family.family_code, "VSA");
  assert.equal(hit.tier.product_code, "86_3");
  assert.equal(hit.rate.term_months, 12);
  assert.equal(findRate(families(), "nope"), null);
});

test("the provider's raw objects are kept", () => {
  // Nothing is lost on the way through, at either level.
  assert.equal(tier("84_7").raw.rateClass, "7");
  assert.equal(tier("84_7").rates[0].raw.unique, "2192");
});
