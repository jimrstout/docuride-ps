// Prepare menu (docs section 25, migration 0045): a deal's columns built from
// the presets with their fallbacks, one price per option across columns,
// surcharges set once for the deal, the band checked on the server, and the
// column footers. Mock data only: every plan, code, cost and price is invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSheet, checkPreparation, customerCents, optionFor, surchargeChoices } from "../supabase/functions/_shared/menu-prepare.ts";
import * as model from "../apps/ownership-planner/lib/prepare-model.ts";
import { planTotals } from "../apps/ownership-planner/lib/money.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const P = "prov-1";

const opt = (code, cost, mandatory = false) => ({ code, label: `Sample ${code}`, cost_delta: cost, mandatory, applied: false });
const rate = (id, months, cost, retail, { deductible = 0, dis = false, options = [] } = {}) => ({
  rate_unique_id: id, term_months: months, term_miles: 0, deductible, deductible_code: null, disappearing_deductible: dis,
  dealer_cost: cost, provider_markup: 0, offered_price: null, options, raw: {}, retail_price: retail,
});
const tier = (code, name, rates) => ({ product_code: code, product_name: name, product_type: "X", provider_id: P, rates, raw: {} });

// Mechanical Protection: one plan, 2 and 4 years. Maintenance: Bronze and Silver.
const LIFT = opt("LIFT", 150);
const DRIVE = opt("DRIVE", 25, true);
const FAMILIES = [
  { family_code: "CARE", provider_id: P, provider_name: "Sample Provider", tiers: [
    tier("CARE-1", "SAMPLE CARE", [rate("c24", 24, 300, 450, { options: [LIFT] }), rate("c48", 48, 500, 750, { options: [LIFT, DRIVE] })]),
  ] },
  { family_code: "PPM", provider_id: P, provider_name: "Sample Provider", tiers: [
    tier("PPM-B", "SAMPLE BRONZE", [rate("b12", 12, 100, 200), rate("b24", 24, 180, 320)]),
    tier("PPM-S", "SAMPLE SILVER", [rate("s24", 24, 260, 420)]),
  ] },
  { family_code: "BAT", provider_id: P, provider_name: "Sample Provider", tiers: [tier("BAT-1", "SAMPLE BATTERY", [rate("t1", 120, 60, 145)])] },
];
const CATALOG = [
  { provider_id: P, product_code: "CARE-1", display_name: "Sample Care", category: "Mechanical Protection", display_order: 110 },
  { provider_id: P, product_code: "PPM-B", display_name: "Sample Maintenance, Bronze", category: "Maintenance", display_order: 100 },
  { provider_id: P, product_code: "PPM-S", display_name: "Sample Maintenance, Silver", category: "Maintenance", display_order: 101 },
  { provider_id: P, product_code: "PPM-G", display_name: "Sample Maintenance, Gold", category: "Maintenance", display_order: 102 },
  { provider_id: P, product_code: "BAT-1", display_name: "Sample Battery", category: "Battery", display_order: 140 },
];
const RULES = [{ id: "r1", tenant_id: "t", store_id: null, provider_id: null, product_code: null, cost_floor: 0, cost_ceiling: 10000,
  markup_percent: 50, markup_min_dollars: 0, markup_max_dollars: null, round_to: 0, active: true, max_markup_percent: 80, max_markup_dollars: null }];
const COLUMNS = [
  { name: "Gold", preset_categories: ["Mechanical Protection", "Maintenance"], starting_level: "Highest" },
  { name: "Silver", preset_categories: ["Mechanical Protection"], starting_level: "Lowest" },
];
const preset = (pos, category, over) => ({ column_position: pos, category, provider_id: null, plan_name: null, term_months: null, term_miles: null, deductible: null, disappearing_deductible: null, ...over });
const PRESETS = [
  preset(1, "Mechanical Protection", { plan_name: "Sample Care", term_months: 48 }),
  preset(2, "Mechanical Protection", { plan_name: "Sample Care", term_months: 24 }),
  preset(1, "Maintenance", { plan_name: "Sample Maintenance, Gold", term_months: 24 }),
];
const input = (over = {}) => ({
  families: FAMILIES, catalog: CATALOG, rules: RULES, columns: COLUMNS, presets: PRESETS,
  prepared: null, prices: {}, surcharges: [], purchased: new Set(), purchased_prices: {}, ...over,
});
const keyOf = (sheet, id) => Object.values(sheet.plans).flat().flatMap((p) => p.options).find((o) => o.rate_unique_id === id).key;

test("each cell starts from its preset, with the fallbacks applied", () => {
  const sheet = buildSheet(input());
  assert.deepEqual(sheet.columns, [{ position: 1, name: "Gold" }, { position: 2, name: "Silver" }]);
  assert.deepEqual(sheet.categories, ["Mechanical Protection", "Maintenance", "Battery"]);
  const at = (pos, cat) => sheet.cells[pos][cat];
  assert.equal(at("1", "Mechanical Protection").key, keyOf(sheet, "c48"));
  assert.equal(at("2", "Mechanical Protection").key, keyOf(sheet, "c24"));
  // Gold did not rate: the next lower plan, Silver, with a plain note.
  assert.equal(at("1", "Maintenance").key, keyOf(sheet, "s24"));
  assert.equal(at("1", "Maintenance").note, "Sample Maintenance, Gold did not rate on this vehicle, so Sample Maintenance, Silver is offered.");
  // No preset and not one of the column's categories: not included, as before.
  assert.deepEqual(at("2", "Maintenance"), { key: null, note: null });
  assert.deepEqual(at("1", "Battery"), { key: null, note: null });
  assert.equal(sheet.prepared, false);
  // Plain words for every option.
  assert.equal(optionFor(sheet, keyOf(sheet, "c48")).option.label, "4 years / Unlimited miles, No deductible");
});

test("a prepared menu is used as it was saved; one no longer offered says so", () => {
  const first = buildSheet(input());
  const sheet = buildSheet(input({ prepared: { "1": { "Mechanical Protection": keyOf(first, "c24"), Maintenance: null }, "2": { Battery: "gone|key" } } }));
  assert.equal(sheet.cells["1"]["Mechanical Protection"].key, keyOf(first, "c24"));
  assert.equal(sheet.cells["1"].Maintenance.key, null);
  assert.deepEqual(sheet.cells["2"].Battery, { key: null, note: "The option prepared here is no longer offered. Choose another." });
  assert.equal(sheet.prepared, true);
});

test("one price per option, the same in every column, and the band from the rule", () => {
  const plain = buildSheet(input());
  const k = keyOf(plain, "c24");
  const sheet = buildSheet(input({ prices: { [k]: { retail_price: 499.99, above_band: false, approved_by: null, reason: null } } }));
  const o = optionFor(sheet, k).option;
  assert.deepEqual([o.dealer_cost, o.rule_price, o.price], [30000, 45000, 49999]);
  // At least the rule's minimum (none) over cost, up to 80% over cost.
  assert.deepEqual(o.band, { floor: 30000, top: 54000 });
  // The same option chosen in both columns reads one price.
  const both = { "1": { "Mechanical Protection": k }, "2": { "Mechanical Protection": k } };
  const state = { ...model.initialState(sheet), cells: both };
  assert.equal(model.cellFigures(o, state).price, model.cellFigures(optionFor(sheet, k).option, state).price);
});

test("surcharges are set once for the deal and apply in every column, at dealer cost", () => {
  assert.deepEqual(surchargeChoices(FAMILIES), [{ code: "LIFT", label: "Sample LIFT" }]);
  const sheet = buildSheet(input({ surcharges: ["LIFT", "NOT-OFFERED"] }));
  assert.deepEqual(sheet.surcharges.chosen, ["LIFT"]);
  const c24 = optionFor(sheet, keyOf(sheet, "c24")).option;
  const c48 = optionFor(sheet, keyOf(sheet, "c48")).option;
  // Lift Kit on both; Drive is mandatory on the 4-year, so it rides along there.
  assert.deepEqual([c24.surcharge_cost, c48.surcharge_cost], [15000, 17500]);
  assert.deepEqual([customerCents(c24), customerCents(c48)], [60000, 92500]);
  // A plan that does not offer it is unchanged.
  assert.equal(optionFor(sheet, keyOf(sheet, "b12")).option.surcharge_cost, 0);
  // On screen: ticking Lift Kit raises every column that holds a product offering it.
  const plain = buildSheet(input());
  const s0 = { ...model.initialState(plain), cells: { "1": { "Mechanical Protection": keyOf(plain, "c48") }, "2": { "Mechanical Protection": keyOf(plain, "c24") } } };
  const s1 = { ...s0, surcharges: ["LIFT"] };
  const none = (prices) => null;
  assert.deepEqual([model.columnFigures(plain, s0, "1", none).total, model.columnFigures(plain, s0, "2", none).total], [77500, 45000]);
  assert.deepEqual([model.columnFigures(plain, s1, "1", none).total, model.columnFigures(plain, s1, "2", none).total], [92500, 60000]);
  // Surcharges pass at cost: profit does not move.
  assert.equal(model.columnFigures(plain, s1, "1", none).profit, model.columnFigures(plain, s0, "1", none).profit);
});

test("editing a price in one column changes it in every column that offers the option", () => {
  const sheet = buildSheet(input());
  const k = keyOf(sheet, "c24");
  const s = { ...model.initialState(sheet), cells: { "1": { "Mechanical Protection": k }, "2": { "Mechanical Protection": k } } };
  const edited = { ...s, prices: { [k]: 50000 } };
  const none = () => null;
  assert.equal(model.columnFigures(sheet, edited, "1", none).total, 50000);
  assert.equal(model.columnFigures(sheet, edited, "2", none).total, 50000);
  assert.equal(model.columnFigures(sheet, edited, "1", none).profit, 20000);
  // Only what changed is sent, once, by option.
  assert.deepEqual(model.payloadOf(sheet, edited).prices, { [k]: 50000 });
  assert.deepEqual(model.payloadOf(sheet, { ...edited, prices: { [k]: 45000 } }).prices, {});
});

test("the column footer's payment is the menu's own, to the cent", () => {
  const sheet = buildSheet(input());
  const s = { ...model.initialState(sheet), cells: { "1": { "Mechanical Protection": keyOf(sheet, "c48"), Maintenance: keyOf(sheet, "s24") } } };
  const monthlyOf = (prices) => planTotals(12000, prices, 6.99, 60, null).planPayment;
  const f = model.columnFigures(sheet, s, "1", monthlyOf);
  // The 4-year Care carries its mandatory $25 at cost.
  assert.equal(f.total, 75000 + 2500 + 42000);
  assert.equal(f.monthly, Math.round(planTotals(12000, [775, 420], 6.99, 60, null).planPayment * 100));
  assert.equal(model.columnFigures(sheet, s, "1", () => null).monthly, null);
});

test("the server's check: never below dealer cost, outside the range needs a manager, purchased stays locked", () => {
  const sheet = buildSheet(input({ purchased: new Set([`${P}:BAT-1`]), purchased_prices: { [`${P}:BAT-1`]: 145 } }));
  const k = keyOf(sheet, "c24");
  assert.deepEqual(checkPreparation(sheet, { cells: {}, prices: { [k]: 52000 }, surcharges: [] }), {
    errors: [], above_band: [], below_band: [], writes: [{ key: k, retail_cents: 52000, above_band: false, below_band: false }],
  });
  const over = checkPreparation(sheet, { cells: {}, prices: { [k]: 60000 }, surcharges: [] });
  assert.deepEqual([over.errors, over.above_band, over.writes[0].above_band], [[], [k], true]);
  assert.deepEqual(checkPreparation(sheet, { cells: {}, prices: { [k]: 29999 }, surcharges: [] }).errors,
    ["Sample Care, 2 years / Unlimited miles, No deductible: $299.99 is below the minimum allowable price of $300.00."]);
  const bat = keyOf(sheet, "t1");
  assert.deepEqual(checkPreparation(sheet, { cells: { "1": { Battery: bat } }, prices: { [bat]: 20000 }, surcharges: ["NOPE"] }).errors, [
    "A surcharge chosen is not offered on this vehicle.",
    "Gold, Battery: Sample Battery is already purchased, so it cannot be changed.",
    "Sample Battery, 10 years / Unlimited miles, No deductible is already purchased, so its price cannot be changed.",
  ]);
  assert.deepEqual(checkPreparation(sheet, { cells: { "1": { Maintenance: k } }, prices: {}, surcharges: [] }).errors,
    ["Gold, Maintenance: that option is not offered on this vehicle."]);
  // Purchased products show locked, in every column, at the price they were sold for.
  assert.deepEqual(sheet.purchased, [{ category: "Battery", plan_name: "Sample Battery", price: 14500 }]);
  assert.equal(model.columnFigures(sheet, model.initialState(sheet), "2", () => null).total, 45000 + 14500);
});

test("money reads as money", () => {
  assert.equal(model.dollars(123456), "$1,234.56");
  assert.equal(model.dollars(null), "Not priced");
  assert.equal(model.readCents("$1,200"), 120000);
  assert.equal(model.readCents("450.5"), 45050);
  assert.equal(model.readCents("4.555"), null);
  assert.equal(model.readCents("abc"), null);
});

test("the endpoint: secret, managers outside the range, locked once chosen, events, nothing priced in a log", () => {
  const fn = read("supabase/functions/fni-menu-prepare/index.ts");
  assert.match(fn, /if \(!secretsMatch\(presented, Deno\.env\.get\("FNI_WEBHOOK_SECRET"\)\)\) return json\(401/);
  assert.match(fn, /if \(s\.menu_prices_locked_at\) return json\(409, \{ error: LOCKED \}\);/);
  assert.match(fn, /const outside = check\.above_band\.length \+ check\.below_band\.length;\s*if \(outside > 0 && \(!\(await isManager\(supabase, body\.manager_id\)\) \|\| reason === "" \|\| managerName === ""\)\) \{\s*return json\(403, \{ error: NEEDS_MANAGER/);
  assert.match(fn, /\.rpc\("is_menu_manager", \{ p_user: id \}\)/);
  assert.match(fn, /\[\[check\.above_band, ABOVE_BAND_EVENT\], \[check\.below_band, BELOW_BAND_EVENT\]\]/);
  assert.ok(fn.includes('event: UNLOCKED_EVENT'));
  assert.match(fn, /export const ABOVE_BAND_EVENT = "Price above the band allowed by a manager on Prepare menu";/);
  for (const m of fn.matchAll(/console\.\w+\("[^"]*",([^;]*)\);/g)) assert.doesNotMatch(m[1], /price\b|retail|reason|manager_name|label/, m[1]);
  assert.match(read("supabase/config.toml"), /\[functions\.fni-menu-prepare\]\nverify_jwt = false/);

  const actions = read("apps/ownership-planner/app/prepare/[sessionId]/actions.ts");
  assert.match(actions, /const operator = await currentOperator\(\);\s*if \(!operator\) return \{ ok: false, error: "Sign in to prepare the menu\." \};/);
  assert.match(actions, /await edge\.adminAuth<\{ user_id: string; email: string \}>\(manager\.email\.trim\(\), manager\.password\)/);
  const page = read("apps/ownership-planner/app/prepare/[sessionId]/page.tsx");
  assert.match(page, /const operator = await currentOperator\(\);\s*if \(!operator\) return/);
  const details = read("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(details, /href=\{`\/prepare\/\$\{sessionId\}`\} prefetch=\{false\}>\s*Prepare menu\s*<\/Link>/);
  // No scrolling, and tabs on a phone, as the menu.
  const css = read("apps/ownership-planner/app/prepare/[sessionId]/prepare.css");
  assert.match(css, /\.pm \{[^}]*height: 100dvh;\s*overflow: hidden;/);
  assert.match(css, /@media \(max-width: 760px\), \(max-height: 560px\)/);
  for (const f of ["supabase/functions/_shared/menu-prepare.ts", "apps/ownership-planner/app/prepare/[sessionId]/Prepare.tsx", "apps/ownership-planner/lib/prepare-model.ts"]) {
    assert.doesNotMatch(read(f), /—/, f);
  }
});

test("each column's footer shows a payment for each of its terms, the deal's first", async () => {
  const { columnTerms } = await import("../supabase/functions/_shared/menu-terms.ts");
  const sheet = buildSheet(input({ terms: { "1": [{ months: 72, rate: 7.74 }], "2": [] } }));
  assert.deepEqual(sheet.terms, { "1": [{ months: 72, rate: 7.74 }], "2": [] });
  const s = { ...model.initialState(sheet), cells: { "1": { "Mechanical Protection": keyOf(sheet, "c48") }, "2": { "Mechanical Protection": keyOf(sheet, "c24") } } };
  const deal = { months: 60, rate: 5.9 };
  const on = (prices, t) => planTotals(12000, prices, t.rate, t.months, null).totalPayment;
  const gold = model.columnFigures(sheet, s, "1", () => null, columnTerms(deal, s.terms["1"]), on);
  assert.deepEqual(gold.payments.map((p) => [p.months, p.rate, p.deal_term]), [[60, 5.9, true], [72, 7.74, false]]);
  assert.equal(gold.payments[1].monthly, Math.round(planTotals(12000, [775], 7.74, 72, null).totalPayment * 100));
  // Each column its own set of terms.
  assert.equal(model.columnFigures(sheet, s, "2", () => null, columnTerms(deal, s.terms["2"]), on).payments.length, 1);
  // A cash deal: no terms, no payments, and no terms sent.
  assert.deepEqual(model.columnFigures(sheet, s, "1", () => null, columnTerms(null, s.terms["1"]), on).payments, []);
  assert.equal("terms" in model.payloadOf(sheet, s, false), false);
  assert.deepEqual(model.payloadOf(sheet, s, true).terms, { "1": [{ months: 72, rate: 7.74 }], "2": [] });
});

test("terms are saved checked, cash deals refused; Reset the menu brings removed products back and is recorded", () => {
  const fn = read("supabase/functions/fni-menu-prepare/index.ts");
  assert.match(fn, /check\.errors\.push\("A cash deal has no payments, so it has no payment terms\."\);/);
  assert.match(fn, /const got = parseTerms\(Array\.isArray\(raw\) \? raw : \[\], c\.name\);/);
  assert.match(fn, /\.\.\.\(menuTerms !== undefined \? \{ menu_terms: menuTerms \} : \{\}\),/);
  assert.match(fn, /if \(body\.action === "reset"\) \{\s*if \(s\.menu_prices_locked_at\) return json\(409, \{ error: LOCKED \}\);/);
  assert.match(fn, /\.update\(\{ menu_removed: null \}\)/);
  assert.match(fn, /export const RESET_EVENT = "Menu reset to the prepared state";/);
  const rows = read("supabase/functions/_shared/menu-prepare-rows.ts");
  // The deal's own terms first, else the presets'; a cash deal none.
  assert.match(rows, /const financed = presetDealType\(s\.finance_type\) === "Financed";/);
  assert.match(rows, /terms\[String\(pos\)\] = Array\.isArray\(own\)/);
});
