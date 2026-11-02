// Rating again never leaves stale products (_shared/stale-offers.ts).
//
// A product, term or price the new rating no longer offers comes off the menu
// and out of every column total, with a plain notice on Details and Prepare
// presentation; a price set on an earlier rating that does not fit the new one
// is not applied; and the provider's words about a product it did not rate are
// shown, naming it. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyDealPrices, buildSheet, optionFor, preparedForMenu } from "../supabase/functions/_shared/menu-prepare.ts";
import { optionKey } from "../supabase/functions/_shared/menu-presets.ts";
import { priceFamilies } from "../supabase/functions/_shared/plan-prices.ts";
import { buildSubmitQuote } from "../supabase/functions/_shared/offer-selections.ts";
import { priceProblems } from "../supabase/functions/_shared/price-guard.ts";
import { joinList, providerMessages } from "../supabase/functions/_shared/stale-offers.ts";
import * as model from "../apps/ownership-planner/lib/prepare-model.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const P = "prov-1";
const rate = (id, months, cost) => ({
  rate_unique_id: id, term_months: months, term_miles: 0, deductible: 0, deductible_code: null, disappearing_deductible: false,
  dealer_cost: cost, provider_markup: 0, offered_price: null, options: [], raw: {},
});
const tier = (code, name, ptype, rates) => ({ product_code: code, product_name: name, product_type: ptype, provider_id: P, rates, raw: {} });
const MP = { family_code: "VSA", provider_id: P, provider_name: "Sample", tiers: [tier("MP-1", "SAMPLE CARE", "VSA", [rate("mp48", 48, 500)])] };
const GAP = { family_code: "GAP", provider_id: P, provider_name: "Sample", tiers: [tier("GAP-1", "SAMPLE GAP", "GAP", [rate("gap60", 60, 200)])] };
const CATALOG = [
  { provider_id: P, product_code: "MP-1", display_name: "Mechanical Protection", category: "Mechanical Protection", display_order: 110 },
  { provider_id: P, product_code: "GAP-1", display_name: "GAP", category: "Other", display_order: 150 },
];
const RULES = [{ id: "r", tenant_id: "t", store_id: null, provider_id: null, product_code: null, cost_floor: 0, cost_ceiling: 9999,
  markup_percent: 50, markup_min_dollars: 0, markup_max_dollars: null, round_to: 0, active: true, max_markup_percent: 80, max_markup_dollars: null }];
const COLUMNS = [
  { name: "Platinum", preset_categories: [], starting_level: "Highest" },
  { name: "Gold", preset_categories: [], starting_level: "Highest" },
  { name: "Silver", preset_categories: [], starting_level: "Highest" },
  { name: "Bronze", preset_categories: [], starting_level: "Lowest" },
];
const K_MP = optionKey(P, "MP-1", rate("mp48", 48, 500));
const K_GAP = optionKey(P, "GAP-1", rate("gap60", 60, 200));
// GAP chosen in Platinum, Gold and Silver; Mechanical Protection in all four.
const PREPARED = {
  "1": { "Mechanical Protection": K_MP, Other: K_GAP },
  "2": { "Mechanical Protection": K_MP, Other: K_GAP },
  "3": { "Mechanical Protection": K_MP, Other: K_GAP },
  "4": { "Mechanical Protection": K_MP },
};
const sheetFor = (families, prices = {}) => buildSheet({
  families: priceFamilies(families, RULES), catalog: CATALOG, rules: RULES, columns: COLUMNS, presets: [],
  prepared: PREPARED, prices, surcharges: [], purchased: new Set(), purchased_prices: {},
});
const total = (sheet, pos) => model.columnFigures(sheet, model.initialState(sheet), pos, () => null).total;

test("rated with GAP: it is in Platinum, Gold and Silver and their totals", () => {
  const sheet = sheetFor([MP, GAP]);
  for (const pos of ["1", "2", "3"]) assert.equal(sheet.cells[pos].Other.key, K_GAP);
  assert.deepEqual(sheet.notices, []);
  // Mechanical Protection $750 (500 + 50%) and GAP $300 (200 + 50%).
  assert.equal(total(sheet, "1"), 105000);
  assert.equal(total(sheet, "4"), 75000);
});

test("rated again without GAP: gone from every column and total, and the notice names it", () => {
  const sheet = sheetFor([MP]);
  for (const pos of ["1", "2", "3", "4"]) assert.equal(sheet.cells[pos].Other, undefined);
  assert.ok(!sheet.categories.includes("Other"));
  for (const pos of ["1", "2", "3"]) assert.equal(total(sheet, pos), 75000);
  assert.deepEqual(sheet.notices, ["GAP is no longer offered for this deal after rating again, so it was removed from Platinum, Gold and Silver."]);
  // The customer's menu takes the same cells: no GAP anywhere.
  const menu = preparedForMenu(sheet);
  for (const row of Object.values(menu.cells)) assert.ok(!Object.values(row).some((c) => c?.product_code === "GAP-1"));
});

test("the Submit guard passes on what remains", () => {
  const sheet = sheetFor([MP]);
  const mp = optionFor(sheet, K_MP);
  const offer = { quote: { vehicles: [{ products: [
    { unique: "MP-1", label: "SAMPLE CARE", rates: [{ unique: "mp48", termMonths: 48, dealerCost: { amount: 500 }, subTotal: { amount: mp.option.price / 100 }, options: [] }] },
  ] }] } };
  const selection = { product_unique: "MP-1", rate_unique: "mp48", option_uniques: [], retail_price: mp.option.price / 100, term_months: 48 };
  const { quote, resolved } = buildSubmitQuote(offer, [selection]);
  assert.deepEqual(priceProblems(quote, resolved.map((r) => ({
    rate_unique: r.rateUniqueId, product_name: r.productName, price: selection.retail_price, product_unique: "MP-1", term_months: 48,
  }))), []);
});

test("a term no longer offered is named with its term", () => {
  const MP36 = { ...MP, tiers: [tier("MP-1", "SAMPLE CARE", "VSA", [rate("mp36", 36, 450)])] };
  const sheet = sheetFor([MP36, GAP]);
  assert.deepEqual(sheet.notices, [
    "Mechanical Protection, 4 years is no longer offered for this deal after rating again, so it was removed from Platinum, Gold, Silver and Bronze.",
  ]);
});

test("a price from an earlier rating that does not fit this one is not applied", () => {
  // $600 was set when the dealer cost was lower; the new cost is $650.
  const stale = { [K_MP]: { retail_price: 600, above_band: false, below_band: false, approved_by: null, reason: null } };
  const MP650 = { ...MP, tiers: [tier("MP-1", "SAMPLE CARE", "VSA", [rate("mp48", 48, 650)])] };
  const sheet = sheetFor([MP650], stale);
  const o = optionFor(sheet, K_MP).option;
  assert.equal(o.price, 97500, "the rating's price, $650 + 50%");
  assert.equal(o.not_applied_price, 60000);
  assert.match(sheet.notices.join(" "), /Mechanical Protection, 4 years \/ Unlimited miles, No deductible: the price of \$600\.00 was set on an earlier rating and does not fit this one, so it is not applied\. The rating's price of \$975\.00 is used\./);
  // Prepare shows it as Not applied.
  const f = model.cellFigures(o, model.initialState(sheet));
  assert.equal(f.not_applied, true);
  assert.equal(f.entered, 60000);
  assert.equal(f.price, 97500);
  // The customer's menu and the save use the rating's price too.
  const priced = applyDealPrices(priceFamilies([MP650], RULES), stale, RULES);
  assert.equal(priced[0].tiers[0].rates[0].retail_price, 975);
  // One that still fits is applied as before.
  const fits = { [K_MP]: { retail_price: 800, above_band: false, below_band: false, approved_by: null, reason: null } };
  assert.equal(applyDealPrices(priceFamilies([MP650], RULES), fits, RULES)[0].tiers[0].rates[0].retail_price, 800);
});

test("the provider's words about a product it did not rate show, naming it", () => {
  const response = { quote: { vehicles: [{ products: [
    { unique: "GAP-1", label: "SAMPLE GAP - SAMPLE", rates: [], message: "No rates available" },
    { unique: "TH-1", label: "SAMPLE THEFT - SAMPLE", rates: [] },
    { unique: "MP-1", label: "SAMPLE CARE - SAMPLE", rates: [{ unique: "x" }] },
  ] }] } };
  const names = { "GAP-1": "GAP", "MP-1": "Mechanical Protection" };
  assert.deepEqual(providerMessages(response, (code, label) => names[code] ?? label.split(" - ")[0]), [
    'GAP: the provider says "No rates available".',
    "SAMPLE THEFT: the provider offered no rates for this deal.",
  ]);
  assert.equal(joinList(["Platinum", "Gold", "Silver"]), "Platinum, Gold and Silver");
});

test("Details and Prepare presentation show the notices", () => {
  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /if \(s\.menu_prepared\) ratingNotices\.push\(\.\.\.\(await loadSheet\(supabase, s\)\)\.sheet\.notices\);/);
  assert.match(verify, /rating_notices: ratingNotices,/);
  assert.match(read("apps/ownership-planner/app/details/[sessionId]/page.tsx"), /\(sheet\.rating_notices \?\? \[\]\)\.map\(\(line\) => \(/);
  assert.match(read("apps/ownership-planner/app/prepare/[sessionId]/Prepare.tsx"), /\(sheet\.notices \?\? \[\]\)\.map\(\(line\) => \(/);
});
