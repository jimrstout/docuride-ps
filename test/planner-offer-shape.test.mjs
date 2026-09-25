// Reading a real TecAssured quote.
//
// The fixture is the verbatim 78,708-byte response the QA server returned on
// 2026-09-25 for dealer 3-306, UTV, serial 4XARSM994V8046456. Fake buyer data
// only (Parkersburg, WV 26101) and no Zoho deal behind it.
//
// It exists because the previous fixture, test/fixtures/rated-offer.mjs, says
// UNCONFIRMED at the top and guessed every key name. It guessed wrong. These
// tests pin the real names so that cannot happen again silently.
//
// NOT covered here: _shared/planner-offers.ts normalizeOffer(). It looks for
// products under a top-level `products`/`productTypes` key and returns an empty
// array for a real quote, and it models one price per product where a real
// product has many rates. That is a data-model change, not a rename, so it is
// reported rather than quietly patched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applySelections,
  amountOf,
  deepClone,
} from "../supabase/functions/_shared/offer-selections.ts";

const QUOTE = JSON.parse(
  readFileSync(new URL("./fixtures/tecassured-rate-utv-3-306.json", import.meta.url), "utf8")
);

const products = () => QUOTE.quote.vehicles[0].products;
const fresh = () => deepClone(QUOTE);

// ── What the response actually is ────────────────────────────────────────

test("the quote is shaped quote.vehicles[].products[].rates[]", () => {
  assert.deepEqual(Object.keys(QUOTE), ["quote"]);
  assert.equal(QUOTE.quote.referenceNumber, "2026092514");
  assert.equal(QUOTE.quote.vehicles.length, 1);
  assert.equal(QUOTE.quote.vehicles[0].vehicleType, "UTV");
  assert.equal(products().length, 11);
  assert.equal(products().reduce((n, p) => n + p.rates.length, 0), 41);
});

test("a product names itself with label, ptype and unique", () => {
  const p = products()[0];
  assert.equal(p.label, "RA BATTERY PLUS USED - RIDERS ADVANTAGE BATTERY");
  assert.equal(p.ptype, "BAT");
  assert.equal(p.unique, "754_6");
});

test("the keys the old code read do not exist on any product", () => {
  // This is the whole bug in one assertion.
  for (const p of products()) {
    for (const guessed of ["name", "productName", "description", "productType", "type", "category", "productId", "id"]) {
      assert.equal(p[guessed], undefined, `product ${p.unique} unexpectedly has ${guessed}`);
    }
  }
});

test("ident is 0 on every product, so it is not an identifier", () => {
  for (const p of products()) assert.equal(String(p.ident), "0");
  // unique is, and it is distinct across products.
  assert.equal(new Set(products().map((p) => p.unique)).size, 11);
});

test("money is always { amount, currency }", () => {
  for (const p of products()) {
    for (const r of p.rates) {
      assert.equal(typeof r.dealerCost.amount, "number");
      assert.equal(r.dealerCost.currency, "USD");
      assert.equal(amountOf(r.dealerCost), r.dealerCost.amount);
    }
  }
});

test("term and price live on the rate, not the product", () => {
  // Why normalizeOffer's one-price-per-product model does not fit.
  const platinum = products().find((p) => p.unique === "84_7");
  assert.equal(platinum.dealerCost, undefined);
  assert.equal(platinum.termMonths, undefined);
  assert.deepEqual(platinum.rates.map((r) => r.termMonths), [36, 48]);
  assert.deepEqual(platinum.rates.map((r) => r.dealerCost.amount), [1044, 1180]);
});

// ── What applySelections makes of it ─────────────────────────────────────

test("a selection resolves to the label, the ptype and the unique", () => {
  const resolved = applySelections(fresh(), [
    { product_unique: "84_7", rate_unique: "2192", retail_price: 1400 },
  ]);

  assert.equal(resolved.length, 1);
  const r = resolved[0];
  assert.equal(r.productName, "USED PLATINUM UTV (Side by Side) - RIDERS ADVANTAGE PPM");
  assert.equal(r.productType, "PPM");
  assert.equal(r.providerProductId, "84_7");
  assert.equal(r.rateUniqueId, "2192");
  assert.equal(r.termMonths, 36);
  assert.equal(r.dealerCost, 1044);
});

test("the old behaviour would have been 754_6 and Unknown", () => {
  // Stated as the regression it is: these are what the guessed keys produced.
  const r = applySelections(fresh(), [
    { product_unique: "754_6", rate_unique: "34343", retail_price: 200 },
  ])[0];
  assert.notEqual(r.productName, "754_6");
  assert.notEqual(r.productType, "Unknown");
  assert.equal(r.productType, "BAT");
});

test("a mandatory option rides along unticked, and is costed", () => {
  // USED ATV/UTV CARE-SVC DRIVE carries Service_Drive as mandatory: true.
  const offer = fresh();
  const resolved = applySelections(offer, [
    { product_unique: "86_3", rate_unique: "2210-5", retail_price: 1200 },
  ]);

  const r = resolved[0];
  assert.equal(r.dealerCost, 903);

  const rate = offer.quote.vehicles[0].products
    .find((p) => p.unique === "86_3").rates.find((x) => x.unique === "2210-5");
  const svc = rate.options.find((o) => o.unique === "Service_Drive");
  assert.equal(svc.mandatory, true);
  assert.equal(svc.selected, true, "a mandatory option must be selected");
  // Its dealerCost is 0.0 here, so it adds nothing -- but it was counted.
  assert.equal(r.optionCostTotal, 0);
  // Everything the customer did not tick stays off.
  for (const o of rate.options.filter((x) => x.unique !== "Service_Drive")) {
    assert.equal(o.selected, false);
  }
});

test("a ticked option is added to the option cost", () => {
  const r = applySelections(fresh(), [
    { product_unique: "16_3", rate_unique: "1898-5", option_uniques: ["Trailer", "HVAC"], retail_price: 1500 },
  ])[0];
  // Trailer 75 + HVAC 125.
  assert.equal(r.optionCostTotal, 200);
  assert.equal(r.dealerCost, 653);
});

test("only the chosen rate is flagged, on the chosen product only", () => {
  const offer = fresh();
  applySelections(offer, [
    { product_unique: "84_7", rate_unique: "2192", retail_price: 1400 },
  ]);

  const all = offer.quote.vehicles[0].products;
  assert.equal(all.filter((p) => p.selected).length, 1);
  assert.equal(all.find((p) => p.selected).unique, "84_7");

  const flagged = all.flatMap((p) => p.rates).filter((r) => r.selected);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].unique, "2192");
});

test("markup is retail minus dealer cost minus options", () => {
  // Money: 1400 retail against 1044 cost and a 250 ticked surcharge = 106.
  const offer = fresh();
  applySelections(offer, [
    { product_unique: "84_7", rate_unique: "2192", option_uniques: ["Service_Drive"], retail_price: 1400 },
  ]);
  const rate = offer.quote.vehicles[0].products
    .find((p) => p.unique === "84_7").rates.find((r) => r.unique === "2192");

  assert.equal(rate.systemMarkup.adjustment.amount, 106);
  assert.equal(rate.subTotal.amount, 1400);
});

test("an unknown selection resolves to nothing rather than guessing", () => {
  assert.deepEqual(applySelections(fresh(), [
    { product_unique: "does-not-exist", rate_unique: "nope", retail_price: 1 },
  ]), []);
});

test("the quote is accepted with or without the outer quote key", () => {
  // rated_offers.response_payload may hold either.
  const inner = { vehicles: deepClone(QUOTE.quote.vehicles) };
  const r = applySelections(inner, [
    { product_unique: "84_7", rate_unique: "2192", retail_price: 1400 },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].productType, "PPM");
});
