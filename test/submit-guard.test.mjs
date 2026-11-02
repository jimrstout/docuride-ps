// The Submit guard: before the provider is called, every outgoing product is
// checked against the saved selection: the same product, the term the
// customer chose, and the customer's price to the cent. Nothing unselected
// goes out. Any difference refuses the submit with a plain sentence naming the
// product, what was selected and what would go out (_shared/price-guard.ts).
// Never submits anything. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { priceProblems } from "../supabase/functions/_shared/price-guard.ts";
import { savedSelections } from "../supabase/functions/_shared/saved-selections.ts";

// A cut-down quote as the submit builds it: two products, one rate each.
const rate = (unique, months, amount) => ({ unique, termMonths: months, subTotal: { amount } });
const quote = (overrides = {}) => ({
  vehicles: [{ products: [
    { unique: "MP-1", label: "SAMPLE CARE", rates: [rate("mp48", overrides.mpTerm ?? 48, overrides.mpPrice ?? 746.0)] },
    { unique: "PM-1", label: "SAMPLE MAINTENANCE", rates: [rate("pm24", 24, overrides.pmPrice ?? 343.0)] },
    ...(overrides.extra ? [{ unique: "GAP-1", label: "SAMPLE GAP", rates: [rate("gap60", 60, 200)] }] : []),
  ] }],
});
const SELECTED = [
  { rate_unique: "mp48", product_name: "Mechanical Protection", price: 746.0, product_unique: "MP-1", term_months: 48 },
  { rate_unique: "pm24", product_name: "Priority Maintenance, Bronze", price: 343.0, product_unique: "PM-1", term_months: 24 },
];

test("matching products, terms and prices pass", () => {
  assert.deepEqual(priceProblems(quote(), SELECTED), []);
});

test("a one-cent difference on any product blocks Submit and names it, with both prices", () => {
  assert.deepEqual(priceProblems(quote({ mpPrice: 746.01 }), SELECTED), [
    "Mechanical Protection: the contract would carry $746.01, but the customer's price is $746.00.",
  ]);
  assert.deepEqual(priceProblems(quote({ pmPrice: 342.99 }), SELECTED), [
    "Priority Maintenance, Bronze: the contract would carry $342.99, but the customer's price is $343.00.",
  ]);
});

test("a different term blocks Submit and names the product and both terms", () => {
  assert.deepEqual(priceProblems(quote({ mpTerm: 12 }), SELECTED), [
    "Mechanical Protection: the contract would carry 12 months, but the customer chose 48 months.",
  ]);
});

test("a different product, a missing one, or one nobody selected blocks Submit", () => {
  // The selected rate found under another product.
  const swapped = { vehicles: [{ products: [
    { unique: "OTHER", label: "SAMPLE OTHER", rates: [rate("mp48", 48, 746)] },
    { unique: "PM-1", label: "SAMPLE MAINTENANCE", rates: [rate("pm24", 24, 343)] },
  ] }] };
  assert.deepEqual(priceProblems(swapped, SELECTED), [
    "Mechanical Protection: the contract would be for a different product (SAMPLE OTHER) than the one selected.",
  ]);
  // A selected product missing from what would go out.
  const missing = { vehicles: [{ products: [{ unique: "PM-1", label: "SAMPLE MAINTENANCE", rates: [rate("pm24", 24, 343)] }] }] };
  assert.deepEqual(priceProblems(missing, SELECTED), [
    "Mechanical Protection: the contract would carry no price, but the customer's price is $746.00.",
  ]);
  // Something going out that was not selected.
  assert.deepEqual(priceProblems(quote({ extra: true }), SELECTED), [
    "SAMPLE GAP would go out on the contract, but it was not selected.",
  ]);
});

test("the saved selection carries the chosen term to the guard", () => {
  const [s] = savedSelections([{ provider_product_id: "MP-1", rate_unique_id: "mp48", selected_options: [], customer_price: "746.00", retail_price: null, term_months: 48 }]);
  assert.equal(s.term_months, 48);
  assert.equal(s.retail_price, 746);
});

test("Submit runs the guard on product, term and price before the provider is called", () => {
  const submit = readFileSync(new URL("../supabase/functions/fni-contract-submit/index.ts", import.meta.url), "utf8");
  const guard = submit.indexOf("const problems = priceProblems(");
  const call = submit.indexOf("await client.submitContractDetailed(submitPayload)");
  assert.ok(guard > 0 && guard < call);
  assert.match(submit, /product_unique: r\.selection\.product_unique,\n\s*term_months: r\.selection\.term_months \?\? null,/);
  assert.match(submit, /return await refuse\(409, \{ error: `Nothing was sent\. \$\{problems\.join\(" "\)\}`, problems \}\);/);
});
