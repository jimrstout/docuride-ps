// test/invalid-prices.test.mjs
//
// Prepare menu: a typed price that cannot be saved as it stands is named in
// plain words and never counted in the totals (docs section 29). Mock data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSheet } from "../supabase/functions/_shared/menu-prepare.ts";
import * as model from "../apps/ownership-planner/lib/prepare-model.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const P = "prov-1";
// Dealer cost $455.50; staff minimum markup $75 (minimum allowable $530.50); maximum $400 over ($855.50).
const RULES = [{ id: "r", tenant_id: "t", store_id: null, provider_id: null, product_code: null, cost_floor: 0, cost_ceiling: 9999,
  markup_percent: 50, markup_min_dollars: 75, markup_max_dollars: null, round_to: 0, active: true, max_markup_percent: null, max_markup_dollars: 400 }];
const rate = (id, months, cost, retail, ded = 0, dis = false) => ({ rate_unique_id: id, term_months: months, term_miles: 0, deductible: ded,
  deductible_code: null, disappearing_deductible: dis, dealer_cost: cost, provider_markup: 0, offered_price: null, options: [], raw: {}, retail_price: retail });
const FAMILIES = [
  { family_code: "VSA", provider_id: P, provider_name: "Sample", tiers: [{ product_code: "PREM-1", product_name: "SAMPLE PREMIUM", product_type: "VSA",
    provider_id: P, raw: {}, rates: [rate("p24", 24, 455.5, 683.25, 100, true)] }] },
  { family_code: "BAT", provider_id: P, provider_name: "Sample", tiers: [{ product_code: "BAT-1", product_name: "SAMPLE BATTERY", product_type: "BAT",
    provider_id: P, raw: {}, rates: [rate("b120", 120, 60, 145)] }] },
];
const CATALOG = [
  { provider_id: P, product_code: "PREM-1", display_name: "Mechanical Protection, Premium", category: "Mechanical Protection", display_order: 112 },
  { provider_id: P, product_code: "BAT-1", display_name: "Sample Battery", category: "Battery", display_order: 140 },
];
const COLUMNS = [{ name: "Gold", preset_categories: ["Mechanical Protection", "Battery"], starting_level: "Highest" }];
const sheetWith = (prices = {}) => buildSheet({ families: FAMILIES, catalog: CATALOG, rules: RULES, columns: COLUMNS, presets: [],
  prepared: null, prices, surcharges: [], purchased: new Set(), purchased_prices: {} });
const sheet = sheetWith();
const prem = sheet.plans["Mechanical Protection"][0].options[0];
const K = prem.key;
const NAME = "Mechanical Protection, Premium, 2 years / Unlimited miles, $100 Disappearing Deductible";
const typed = (cents) => ({ ...model.initialState(sheet), prices: { [K]: cents } });
const column = (sheet, state) => model.columnFigures(sheet, state, "1", (p) => p.reduce((a, b) => a + b, 0) / 60, [{ months: 60, rate: 5.9, deal_term: true }],
  (p, t) => p.reduce((a, b) => a + b, 0) / t.months);
const BEFORE = column(sheet, model.initialState(sheet));

test("the option reads as asked, at the amounts asked", () => {
  assert.equal(`${sheet.plans["Mechanical Protection"][0].plan_name}, ${prem.label}`, NAME);
  assert.deepEqual([prem.dealer_cost, prem.band.floor, prem.band.top], [45550, 53050, 85550]);
});

test("below dealer cost: the first wording, not applied, no totals change, and Save is blocked", () => {
  const state = typed(10000);
  assert.deepEqual(model.priceProblems(sheet, state).map((p) => [p.kind, p.text]), [
    ["below_cost", `${NAME}: $100.00 is below the minimum allowable price of $455.50.`],
  ]);
  const f = model.cellFigures(prem, state);
  assert.deepEqual([f.not_applied, f.entered, f.price], [true, 10000, prem.price]);
  assert.deepEqual(column(sheet, state), BEFORE);
  assert.equal(model.saveBlocked(sheet, state), true);
  // No one can approve it, so no manager is asked for.
  assert.deepEqual(model.needsManager(sheet, state), []);
});

test("below the floor: the second wording, not applied, no totals change; a manager is asked for", () => {
  // $500.00: at or above dealer cost ($455.50), below the minimum allowable ($530.50).
  // ($400.00 would be below dealer cost, which no one may approve: the first wording.)
  const state = typed(50000);
  assert.deepEqual(model.priceProblems(sheet, state).map((p) => [p.kind, p.text]), [
    ["below_floor", `${NAME}: $500.00 is below the minimum allowable price of $530.50. A manager can approve a lower price, down to $455.50.`],
  ]);
  assert.equal(model.priceProblem("Mechanical Protection, Premium", prem, 40000).kind, "below_cost");
  assert.equal(model.cellFigures(prem, state).not_applied, true);
  assert.deepEqual(column(sheet, state), BEFORE);
  assert.equal(model.saveBlocked(sheet, state), false);
  assert.deepEqual(model.needsManager(sheet, state), [K]);
});

test("a manager's approval below the floor applies the price, and the totals follow", () => {
  // What Prepare menu gets back after the save with a manager (fni-menu-prepare).
  const approved = sheetWith({ [K]: { retail_price: 500, above_band: false, below_band: true, approved_by: "Sample Manager", reason: "Sample reason" } });
  const state = model.initialState(approved);
  const o = approved.plans["Mechanical Protection"][0].options[0];
  const f = model.cellFigures(o, state);
  assert.deepEqual([f.not_applied, f.price, f.profit], [false, 50000, 50000 - 45550]);
  const after = column(approved, state);
  assert.equal(after.total, BEFORE.total - prem.price + 50000);
  assert.notDeepEqual(after.payments, BEFORE.payments);
});

test("a valid typed price applies at once; Save stays blocked while any invalid one remains, each listed", () => {
  const ok = typed(60000);
  assert.deepEqual(model.priceProblems(sheet, ok), []);
  assert.equal(column(sheet, ok).total, BEFORE.total - prem.price + 60000);
  // Two invalid entries: both listed, Save blocked by the one below dealer cost.
  const bat = sheet.plans.Battery[0].options[0];
  const both = { ...model.initialState(sheet), prices: { [K]: 50000, [bat.key]: 5000 } };
  assert.equal(model.priceProblems(sheet, both).length, 2);
  assert.equal(model.saveBlocked(sheet, both), true);
  assert.deepEqual(column(sheet, both), BEFORE);
  // Fixed: Save is open again.
  assert.equal(model.saveBlocked(sheet, { ...both, prices: { [K]: 50000, [bat.key]: 9000 } }), false);

  const view = read("apps/ownership-planner/app/prepare/[sessionId]/Prepare.tsx");
  assert.match(view, /onClick=\{onSave\} disabled=\{pending \|\| blocked\}/);
  assert.match(view, /const onSave = \(\) => \{\s*if \(blocked\) return;/);
  assert.match(view, /\{problems\.map\(\(p\) => <p key=\{p\.key\} className="pm-problem">\{p\.text\}<\/p>\)\}/);
  assert.match(view, /<span className="pm-profit pm-not-applied">Not applied<\/span>/);
  // The old wording is gone from Prepare menu.
  for (const f of ["apps/ownership-planner/app/prepare/[sessionId]/Prepare.tsx", "apps/ownership-planner/lib/prepare-model.ts", "supabase/functions/_shared/menu-presets.ts"]) {
    assert.doesNotMatch(read(f), /No price may go below dealer cost/, f);
    assert.doesNotMatch(read(f), /—/, f);
  }
});
