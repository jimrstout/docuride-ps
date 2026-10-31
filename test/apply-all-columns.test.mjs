// test/apply-all-columns.test.mjs
//
// "Apply to all columns" in a Prepare menu cell dialog (docs section 30).
// Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSheet } from "../supabase/functions/_shared/menu-prepare.ts";
import * as model from "../apps/ownership-planner/lib/prepare-model.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const P = "prov-1";
const rate = (id, months, cost, retail) => ({ rate_unique_id: id, term_months: months, term_miles: 0, deductible: 0, deductible_code: null,
  disappearing_deductible: false, dealer_cost: cost, provider_markup: 0, offered_price: null, options: [], raw: {}, retail_price: retail });
const tier = (code, name, rates) => ({ product_code: code, product_name: name, product_type: "X", provider_id: P, rates, raw: {} });
const FAMILIES = [
  { family_code: "VSA", provider_id: P, provider_name: "Sample", tiers: [
    tier("CARE-1", "SAMPLE CARE", [rate("c12", 12, 220, 330), rate("c24", 24, 300, 450)]),
    tier("PREM-1", "SAMPLE PREMIUM", [rate("p24", 24, 400, 600), rate("p48", 48, 520, 780)]),
  ] },
  { family_code: "BAT", provider_id: P, provider_name: "Sample", tiers: [tier("BAT-1", "SAMPLE BATTERY", [rate("b120", 120, 60, 145)])] },
];
const CATALOG = [
  { provider_id: P, product_code: "CARE-1", display_name: "Mechanical Protection", category: "Mechanical Protection", display_order: 110 },
  { provider_id: P, product_code: "PREM-1", display_name: "Mechanical Protection, Premium", category: "Mechanical Protection", display_order: 112 },
  { provider_id: P, product_code: "BAT-1", display_name: "Sample Battery", category: "Battery", display_order: 140 },
];
const RULES = [{ id: "r", tenant_id: "t", store_id: null, provider_id: null, product_code: null, cost_floor: 0, cost_ceiling: 9999,
  markup_percent: 50, markup_min_dollars: 0, markup_max_dollars: null, round_to: 0, active: true, max_markup_percent: null, max_markup_dollars: null }];
// Basic leaves Mechanical Protection out: "Not included".
const COLUMNS = [
  { name: "Platinum", preset_categories: ["Mechanical Protection", "Battery"], starting_level: "Highest" },
  { name: "Gold", preset_categories: ["Mechanical Protection"], starting_level: "Middle" },
  { name: "Silver", preset_categories: ["Mechanical Protection"], starting_level: "Lowest" },
  { name: "Basic", preset_categories: [], starting_level: "Lowest" },
];
const sheetWith = (over = {}) => buildSheet({ families: FAMILIES, catalog: CATALOG, rules: RULES, columns: COLUMNS, presets: [],
  prepared: null, prices: {}, surcharges: [], purchased: new Set(), purchased_prices: {}, ...over });
const keyOf = (sheet, id) => Object.values(sheet.plans).flat().flatMap((p) => p.options).find((o) => o.rate_unique_id === id).key;
const MP = "Mechanical Protection";

/** Silver's dialog: the plan and term chosen there. */
function chooseInSilver(sheet, id) {
  const state = model.initialState(sheet);
  return { ...state, cells: { ...state.cells, "3": { ...state.cells["3"], [MP]: keyOf(sheet, id) } } };
}

test("applied to all columns: the same option in every column, Not included ones too, at its one shared price", () => {
  const sheet = sheetWith();
  assert.equal(sheet.cells["4"][MP].key, null);
  const before = chooseInSilver(sheet, "p48");
  const priced = { ...before, prices: { [keyOf(sheet, "p48")]: 70000 } };
  const { state, skipped } = model.applyToAllColumns(sheet, priced, "3", MP);
  assert.deepEqual(["1", "2", "3", "4"].map((p) => state.cells[p][MP]), Array(4).fill(keyOf(sheet, "p48")));
  assert.deepEqual(skipped, []);
  // Other categories untouched.
  assert.equal(state.cells["1"].Battery, before.cells["1"].Battery);
  // One price, every column; totals and profits follow.
  const totals = ["1", "2", "3", "4"].map((p) => model.columnFigures(sheet, state, p, () => null));
  assert.deepEqual(totals.map((t) => t.total), [70000 + 14500, 70000, 70000, 70000]);
  assert.deepEqual(totals.map((t) => t.profit), [70000 - 52000 + 14500 - 6000, 18000, 18000, 18000]);
  // Nothing saved: only the screen's state changed.
  assert.deepEqual(model.payloadOf(sheet, state).cells["4"][MP], keyOf(sheet, "p48"));
});

test("a column locked by a purchased product is skipped, and named", () => {
  const sheet = sheetWith();
  const { state, skipped } = model.applyToAllColumns(sheet, chooseInSilver(sheet, "c24"), "3", MP, {
    locked: (pos) => pos === "2",
  });
  assert.deepEqual(skipped, ["Gold was not changed: a purchased product is locked there."]);
  assert.equal(state.cells["2"][MP], sheet.cells["2"][MP].key);
  assert.deepEqual(["1", "3", "4"].map((p) => state.cells[p][MP]), Array(3).fill(keyOf(sheet, "c24")));
  // As built today, a purchase locks its category in every column.
  const bought = sheetWith({ purchased: new Set([`${P}:BAT-1`]), purchased_prices: { [`${P}:BAT-1`]: 145 } });
  const r = model.applyToAllColumns(bought, model.initialState(bought), "1", "Battery");
  assert.equal(r.skipped.length, 3);
  assert.match(r.skipped[0], /^Gold was not changed: a purchased product is locked there\.$/);
});

test("a column where the option does not rate is skipped, and named", () => {
  const sheet = sheetWith();
  const { state, skipped } = model.applyToAllColumns(sheet, chooseInSilver(sheet, "p48"), "3", MP, {
    offers: (pos) => pos !== "4",
  });
  assert.deepEqual(skipped, ["Basic was not changed: this plan is not available for this vehicle in that column."]);
  assert.equal(state.cells["4"][MP], null);
});

test("unchecked: Done changes only the open column", () => {
  const sheet = sheetWith();
  const before = model.initialState(sheet);
  const edited = chooseInSilver(sheet, "c12");
  for (const pos of ["1", "2", "4"]) assert.equal(edited.cells[pos][MP], before.cells[pos][MP]);
  const view = read("apps/ownership-planner/app/prepare/[sessionId]/Prepare.tsx");
  assert.match(view, /<input type="checkbox" checked=\{applyAll\} onChange=\{\(e\) => setApplyAll\(e\.target\.checked\)\} \/> Apply to all columns/);
  // Unchecked by default, every time a dialog opens; only applied when checked.
  assert.match(view, /const \[applyAll, setApplyAll\] = useState\(false\);/);
  assert.match(view, /setEditing\(\{ pos, category \}\);\s*setApplyAll\(false\);/);
  assert.match(view, /if \(applyAll && editing\) \{\s*const r = applyToAllColumns\(sheet, state, editing\.pos, editing\.category\);/);
  // Above Done.
  assert.ok(view.indexOf("Apply to all columns") < view.indexOf(">\n                Done\n"));
});
