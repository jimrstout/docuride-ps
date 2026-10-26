// The price cap (fix 4c). Dealer cost + provider markup + options is the most
// a product may be sold for on QA dealer 3-306 only. A test session on the QA
// server submits every product at that maximum; anywhere else no cap is
// assumed and TecAssured's answer decides.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { atMaximum, pricePolicy, refusalInPlainEnglish } from "../supabase/functions/_shared/price-cap.ts";

const QA = "https://ratessys-qa.com/api";
const PROD = "https://ratessys.com/api";
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("only a test session on the QA server is priced at the maximum", () => {
  assert.equal(pricePolicy({ is_test: true }, QA), "Test at maximum");
  assert.equal(pricePolicy({ is_test: false }, QA), "Provider decides");
  assert.equal(pricePolicy({ is_test: true }, PROD), "Provider decides");
  assert.equal(pricePolicy({ is_test: null }, null), "Provider decides");
});

test("each selection goes at its rate's maximum, to the cent", () => {
  const selections = [
    { product_unique: "24_5", rate_unique: "1448", retail_price: 1450 },
    { product_unique: "755_6", rate_unique: "34347", retail_price: 99.5 },
    { product_unique: "x", rate_unique: "none", retail_price: 10 },
  ];
  const resolved = [
    { rateUniqueId: "1448", offeredPrice: 1044 + 50 },
    { rateUniqueId: "34347", offeredPrice: 0.1 + 0.2 + 120 },
    { rateUniqueId: "none", offeredPrice: null },
  ];
  const out = atMaximum(selections, resolved);
  assert.deepEqual(out.map((s) => s.retail_price), [1094, 120.3, 10]);
  // The customer's own selections are not changed in place.
  assert.equal(selections[0].retail_price, 1450);
});

test("TecAssured's refusals read in plain English", () => {
  assert.equal(
    refusalInPlainEnglish("contract purchase price of $1,450.00 cannot be greater than the maximum selling price of $1,094.00", "Theft, Plan A"),
    "TecAssured would not accept Theft, Plan A: its price, $1,450.00, is above the most TecAssured allows this dealer to sell it for, $1,094.00. Lower the price to $1,094.00 or less and submit again."
  );
  assert.match(refusalInPlainEnglish("no rate found matching criteria", "Tire and Wheel"), /^TecAssured would not accept Tire and Wheel: it has no rate for this product that matches the vehicle\./);
  assert.match(refusalInPlainEnglish("Duplicate contract"), /already has this contract/);
  assert.equal(refusalInPlainEnglish("Something odd."), "TecAssured would not accept the contract: Something odd.");
  assert.equal(refusalInPlainEnglish(""), "TecAssured would not accept the contract, and did not say why.");
  for (const s of ["no rate found matching criteria", "x"]) assert.doesNotMatch(refusalInPlainEnglish(s), /—/);
});

test("submit keeps the cap check for test sessions on QA only, and never changes the customer's price", () => {
  const sub = src("../supabase/functions/fni-contract-submit/index.ts");
  assert.match(sub, /const policy = pricePolicy\(session, credentials\.api_base_url\);/);
  assert.match(sub, /if \(policy === "Test at maximum"\) \{\s+resolved = buildSubmitQuote\(offerPayload, atMaximum\(selections, resolved\)\)\.resolved;/);
  assert.match(sub, /const overCap = policy === "Test at maximum" \? resolved\.filter\(\(r\) => r\.overCap\) : \[\];/);
  assert.match(sub, /customer_price: customerPrice\.get\(r\.rateUniqueId\) \?\? r\.selection\.retail_price,/);
  // Refusals reach staff through the product-by-product reading, which words
  // each one with refusalInPlainEnglish (test/submit-outcome.test.mjs).
  assert.match(src("../supabase/functions/_shared/submit-outcome.ts"), /refusalInPlainEnglish\(no\.error, a\.productName\)/);
});

test("the go-live item is written down", () => {
  const doc = src("../docs/multi-provider.md");
  const golive = doc.slice(doc.indexOf("### Go-live items"), doc.indexOf("## 12."));
  assert.match(golive, /price cap/i);
});
