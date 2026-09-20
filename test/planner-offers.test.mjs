// Normalizing a TecAssured Offer Format response.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOffer } from "../supabase/functions/_shared/planner-offers.ts";
import { RATED_OFFER_RESPONSE } from "./fixtures/rated-offer.mjs";

test("reads every product out of the offer", () => {
  const products = normalizeOffer(RATED_OFFER_RESPONSE);
  assert.equal(products.length, 5);
  assert.deepEqual(
    products.map((p) => p.product_code),
    ["VSC", "GAP", "TW", "KEY", "PPM"]
  );
});

test("carries cost, terms and deductibles across", () => {
  const vsc = normalizeOffer(RATED_OFFER_RESPONSE).find((p) => p.product_code === "VSC");
  assert.equal(vsc.dealer_cost, 1349);
  assert.equal(vsc.term_months, 48);
  assert.equal(vsc.term_miles, 48000);
  assert.equal(vsc.deductible, 100);
  assert.equal(vsc.rate_unique_id, "R-VSC-48-500-0001");
  assert.equal(vsc.product_name, "Vehicle Service Contract");
});

test("surcharges come through in the shape selected_options expects", () => {
  const vsc = normalizeOffer(RATED_OFFER_RESPONSE).find((p) => p.product_code === "VSC");
  assert.equal(vsc.surcharge_options.length, 2);
  assert.deepEqual(vsc.surcharge_options[0], {
    code: "TURBO",
    label: "Turbocharged or supercharged",
    cost_delta: 185,
    applied: false,
  });
});

test("keeps the provider's raw object so nothing is lost before the format is confirmed", () => {
  const gap = normalizeOffer(RATED_OFFER_RESPONSE).find((p) => p.product_code === "GAP");
  assert.equal(gap.raw.rateUnique, "R-GAP-60-0001");
  assert.equal(gap.raw.productType, "Guaranteed Asset Protection");
});

test("accepts the alternative envelopes the response might use", () => {
  const products = RATED_OFFER_RESPONSE.products;
  for (const envelope of [
    { productTypes: products },
    { offers: products },
    { offer: { products } },
    { data: { rates: products } },
  ]) {
    assert.equal(normalizeOffer(envelope).length, 5, JSON.stringify(Object.keys(envelope)));
  }
});

test("money arriving as a display string is still money", () => {
  const [p] = normalizeOffer({
    products: [{ productUnique: "VSC", dealerCost: "1,349.00", termMonths: "48" }],
  });
  assert.equal(p.dealer_cost, 1349);
  assert.equal(p.term_months, 48);
});

test("an unrated session and a malformed response both yield nothing, not a crash", () => {
  for (const bad of [null, undefined, {}, { products: null }, "nope", 42, []]) {
    assert.deepEqual(normalizeOffer(bad), []);
  }
});
