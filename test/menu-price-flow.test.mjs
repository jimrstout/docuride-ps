// The price on the chosen option reaches the contract exactly (docs section 25).
//
// Prepare menu sets a deal's price per option. fni-session-get puts it on the
// offers, the menu shows it, fni-session-save prices the chosen option on the
// server from the same, and Submit sends exactly the selection's customer
// price, refusing a penny's difference before anything is sent. Each case runs
// the real pieces end to end: the sheet, the deal's prices on the offers, the
// save's pricing, the cut-down quote, and the guard. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyDealPrices, buildSheet, checkPreparation, optionFor, preparedForMenu } from "../supabase/functions/_shared/menu-prepare.ts";
import { optionKey } from "../supabase/functions/_shared/menu-presets.ts";
import { customerPriceFor, priceFamilies } from "../supabase/functions/_shared/plan-prices.ts";
import { buildSubmitQuote } from "../supabase/functions/_shared/offer-selections.ts";
import { PRICE_GUARD_EVENT, priceProblems } from "../supabase/functions/_shared/price-guard.ts";
import * as menu from "../apps/ownership-planner/lib/menu-model.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const P = "prov-1";

// ── One mock offer, in the normalized shape and as the provider's quote ──
const LIFT = { code: "LIFT", label: "Sample Lift Kit", cost_delta: 150, mandatory: false, applied: false };
const rate = (id, months, cost, options = []) => ({
  rate_unique_id: id, term_months: months, term_miles: 0, deductible: 0, deductible_code: null, disappearing_deductible: false,
  dealer_cost: cost, provider_markup: 50, offered_price: null, options, raw: {},
});
const familiesNow = () => [
  { family_code: "CARE", provider_id: P, provider_name: "Sample", tiers: [
    { product_code: "CARE-1", product_name: "SAMPLE CARE", product_type: "VSA", provider_id: P, raw: {},
      rates: [rate("c24", 24, 300, [LIFT]), rate("c48", 48, 500, [LIFT])] },
  ] },
];
const quoteFor = () => ({
  quote: { saleDate: "Oct 30, 2026, 1:00:00 PM", vehicles: [{ products: [{ unique: "CARE-1", label: "SAMPLE CARE", ptype: "VSA", rates: [
    { unique: "c24", termMonths: 24, dealerCost: { amount: 300 }, providerMarkup: { adjustment: { amount: 50 } }, subTotal: { amount: 350 },
      options: [{ unique: "LIFT", dealerCost: { amount: 150 }, mandatory: false }] },
    { unique: "c48", termMonths: 48, dealerCost: { amount: 500 }, providerMarkup: { adjustment: { amount: 50 } }, subTotal: { amount: 550 },
      options: [{ unique: "LIFT", dealerCost: { amount: 150 }, mandatory: false }] },
  ] }] }] },
});
const CATALOG = [{ provider_id: P, product_code: "CARE-1", display_name: "Sample Care", category: "Mechanical Protection", display_order: 110 }];
const RULES = [{ id: "r", tenant_id: "t", store_id: null, provider_id: null, product_code: null, cost_floor: 0, cost_ceiling: 9999,
  markup_percent: 50, markup_min_dollars: 0, markup_max_dollars: null, round_to: 0, active: true, max_markup_percent: 80, max_markup_dollars: null }];
const COLUMNS = [
  { name: "Gold", preset_categories: ["Mechanical Protection"], starting_level: "Highest" },
  { name: "Silver", preset_categories: ["Mechanical Protection"], starting_level: "Lowest" },
];
const K24 = optionKey(P, "CARE-1", rate("c24", 24, 300));

/** The whole path for one deal: what Present menu shows, what the save writes, what Submit sends. */
function flow({ prices = {}, surcharges = [], column = 0, prepared = null, tamper = null }) {
  const sheet = buildSheet({ families: priceFamilies(familiesNow(), RULES), catalog: CATALOG, rules: RULES, columns: COLUMNS, presets: [],
    prepared, prices, surcharges, purchased: new Set(), purchased_prices: {} });
  // fni-session-get: the deal's prices on the offers, and the prepared cells.
  const offers = applyDealPrices(priceFamilies(familiesNow(), RULES), prices);
  const rows = menu.buildRows(offers.map((f) => ({ ...f, tiers: f.tiers.map((t) => ({ ...t, available: true })) })), [{ provider_id: P, product_code: "CARE-1", category: "Mechanical Protection", display_name: "Sample Care", is_presentable: true }], [], []);
  const cells = menu.preparedCells(rows, COLUMNS, preparedForMenu(sheet));
  const shown = menu.cellPrice(rows[0], cells[column][0]);
  const chosen = menu.saveDecisions(rows, cells[column], "2026-10-30T12:00:00Z").find((d) => d.disposition === "Included");
  // fni-session-save: priced on the server from the same, never the browser's figure.
  const saved = customerPriceFor(applyDealPrices(priceFamilies(familiesNow(), RULES), prices), chosen.product_code, chosen.rate_unique_id, chosen.selected_options, P);
  // fni-contract-submit: the saved selection, the cut-down quote, the guard.
  const selection = { product_unique: chosen.product_code, rate_unique: chosen.rate_unique_id, option_uniques: chosen.selected_options, retail_price: saved };
  const { quote, resolved } = buildSubmitQuote(quoteFor(), [selection]);
  if (tamper) tamper(quote);
  const problems = priceProblems(quote, resolved.map((r) => ({ rate_unique: r.rateUniqueId, product_name: r.productName, price: saved })));
  return { sheet, shown, browser: chosen.customer_price, saved, problems, quote };
}

test("an edited price is what the menu shows, the save writes and Submit sends", () => {
  const r = flow({ prices: { [K24]: { retail_price: 512.34, above_band: false, approved_by: null, reason: null } }, column: 1 });
  assert.deepEqual([r.shown, r.browser, r.saved], [512.34, 512.34, 512.34]);
  assert.deepEqual(r.problems, []);
  assert.equal(r.quote.vehicles[0].products[0].rates[0].subTotal.amount, 512.34);
});

test("a price shared across columns: the same option in two columns is one price, sent as such", () => {
  const sheet0 = buildSheet({ families: priceFamilies(familiesNow(), RULES), catalog: CATALOG, rules: RULES, columns: COLUMNS, presets: [], prepared: null, prices: {}, surcharges: [], purchased: new Set() });
  const both = { "1": { "Mechanical Protection": K24 }, "2": { "Mechanical Protection": K24 } };
  const prices = { [K24]: { retail_price: 499, above_band: false, approved_by: null, reason: null } };
  const gold = flow({ prices, prepared: both, column: 0 });
  const silver = flow({ prices, prepared: both, column: 1 });
  assert.deepEqual([gold.shown, silver.shown, gold.saved, silver.saved], [499, 499, 499, 499]);
  assert.deepEqual([gold.problems, silver.problems], [[], []]);
  assert.ok(sheet0.columns.length === 2);
});

test("a manager's price above the band reaches the contract exactly", () => {
  // $560.00 on a $300.00 cost: above 80% ($540.00), allowed with a manager and a reason.
  const sheet = flow({}).sheet;
  const check = checkPreparation(sheet, { cells: {}, prices: { [K24]: 56000 }, surcharges: [] });
  assert.deepEqual([check.errors, check.above_band], [[], [K24]]);
  const r = flow({ prices: { [K24]: { retail_price: 560, above_band: true, approved_by: "Sample Manager", reason: "Sample reason" } }, column: 1 });
  assert.deepEqual([r.shown, r.saved], [560, 560]);
  assert.deepEqual(r.problems, []);
});

test("a surcharge set once applies in every column, and is sent inside the price", () => {
  const prices = { [K24]: { retail_price: 450, above_band: false, approved_by: null, reason: null } };
  const both = { "1": { "Mechanical Protection": K24 }, "2": { "Mechanical Protection": K24 } };
  for (const column of [0, 1]) {
    const r = flow({ prices, surcharges: ["LIFT"], prepared: both, column });
    // $450.00 plus the Lift Kit at dealer cost, $150.00.
    assert.deepEqual([r.shown, r.browser, r.saved], [600, 600, 600], `column ${column + 1}`);
    assert.deepEqual(r.problems, []);
    const sent = r.quote.vehicles[0].products[0].rates[0];
    assert.equal(sent.subTotal.amount, 600);
    assert.deepEqual(sent.options.map((o) => o.unique), ["LIFT"]);
  }
});

test("a penny's difference stops Submit, naming the product and both prices", () => {
  const r = flow({ prices: { [K24]: { retail_price: 512.34, above_band: false, approved_by: null, reason: null } }, column: 1,
    tamper: (q) => { q.vehicles[0].products[0].rates[0].subTotal.amount = 512.35; } });
  assert.deepEqual(r.problems, ["SAMPLE CARE: the contract would carry $512.35, but the customer's price is $512.34."]);
  const gone = flow({ column: 1, tamper: (q) => { delete q.vehicles[0].products[0].rates[0].subTotal; } });
  assert.deepEqual(gone.problems, ["SAMPLE CARE: the contract would carry no price, but the customer's price is $450.00."]);
  assert.equal(PRICE_GUARD_EVENT, "Submit stopped: a price differs from the customer's price");
});

test("the browser's figure is never the price: the save prices on the server", () => {
  const save = read("supabase/functions/fni-session-save/index.ts");
  assert.match(save, /const server = included \? serverPrice\(d\) : null;/);
  assert.match(save, /const price = server \?\? browser;/);
  assert.match(save, /retail_price: included \? price : null,\s*customer_price: included \? price : null,/);
  assert.match(save, /return applyDealPrices\(priceFamilies\(familiesFromRows\(offers\), \(ruleRows \?\? \[\]\) as unknown as PricingRule\[\]\), prices\);/);
  // Prices lock when the customer chooses a package.
  assert.match(save, /if \(body\.complete === true && menuEvent\?\.kind === "selected"\) patch\.menu_prices_locked_at = new Date\(\)\.toISOString\(\);/);
  // Logged as a count, never a price.
  for (const m of save.matchAll(/console\.\w+\("[^"]*",([^;]*)\);/g)) assert.doesNotMatch(m[1], /price|server\b|browser\b/, m[1]);
  assert.match(save, /console\.log\("fni-session-save priced on the server", \{ session: sessionId, differed: adjusted \}\);/);
});

test("Submit's guard: before anything is sent, with an event, the maximum only on a QA test session", () => {
  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  const guard = submit.indexOf("const problems = priceProblems(");
  assert.ok(guard > 0 && guard < submit.indexOf("Step 6: Submit"));
  assert.ok(guard > submit.indexOf("const { quote: submitQuote } = buildSubmitQuote("));
  assert.match(submit, /price: policy === "Test at maximum" \? r\.selection\.retail_price : \(customerPrice\.get\(r\.rateUniqueId\) \?\? r\.selection\.retail_price\),/);
  assert.match(submit, /event: PRICE_GUARD_EVENT,\s*detail: \{ problems \},/);
  assert.match(submit, /return await refuse\(409, \{ error: `Nothing was sent\. \$\{problems\.join\(" "\)\}`, problems \}\);/);
  assert.match(submit, /console\.warn\("fni-contract-submit stopped by the price guard", \{ session: session_id, products: problems\.length \}\);/);
});

test("Present menu starts from the prepared menu, or the presets as they stand", () => {
  const get = read("supabase/functions/fni-session-get/index.ts");
  assert.match(get, /if \(prepared\) applyDealPrices\(pricedFamilies, prepared\.input\.prices\);/);
  assert.match(get, /menu_prepared: menuPrepared,/);
  const m = read("apps/ownership-planner/app/menu/[sessionId]/Menu.tsx");
  assert.match(m, /useState<Cell\[\]\[\]>\(\(\) => preparedCells\(rows, columns, initial\.menu_prepared\)\)/);
  // A column with no choice for a category leaves it unchecked.
  const sheet = flow({}).sheet;
  const prepared = preparedForMenu(sheet);
  assert.equal(prepared.cells["1"]["Mechanical Protection"].product_code, "CARE-1");
  // No preset term: the column's level picks the plan, and the shortest term starts it.
  assert.equal(optionFor(sheet, sheet.cells["1"]["Mechanical Protection"].key).option.rate_unique_id, "c24");
});
