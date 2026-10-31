// test/surcharge-groups.test.mjs
//
// The Surcharges dialog on Prepare menu: grouped by category in menu row
// order, a shared surcharge one setting under every heading, counts of one
// item as one picker, and the provider's own code all the way to Submit.
// Mock data only: every plan, code, cost and price is invented, except the
// option codes and labels, which are shaped like the provider's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSheet, checkPreparation, preparedForMenu } from "../supabase/functions/_shared/menu-prepare.ts";
import { countGroups } from "../supabase/functions/_shared/surcharge-display.ts";
import { priceFamilies } from "../supabase/functions/_shared/plan-prices.ts";
import { buildSubmitQuote } from "../supabase/functions/_shared/offer-selections.ts";
import * as model from "../apps/ownership-planner/lib/prepare-model.ts";
import * as menu from "../apps/ownership-planner/lib/menu-model.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const P = "prov-1";
const WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven"];
const opt = (code, label, cost, mandatory = false) => ({ code, label, cost_delta: cost, mandatory, applied: false });
const BATTERIES = WORDS.map((w, i) => opt(`Add_${i + 1}_Battery`, `Add ${w} ${i === 0 ? "Battery" : "Batteries"}`, 20 * (i + 1)));
const LITHIUM = opt("Lithium", "Lithium Battery", 30);
const CHROME = opt("Chrome/Aftermarket", "Chrome/Aftermarket Wheels", 60);
const COMMERCIAL = opt("COMMERCIAL", "Commercial Use - All Dealers", 40);
const rate = (id, months, cost, options) => ({
  rate_unique_id: id, term_months: months, term_miles: 0, deductible: 0, deductible_code: null, disappearing_deductible: false,
  dealer_cost: cost, provider_markup: 0, offered_price: null, options, raw: {},
});
const tier = (code, name, rates) => ({ product_code: code, product_name: name, product_type: "X", provider_id: P, rates, raw: {} });
// Commercial Use is offered by Mechanical Protection and by Tire and Wheel: shared.
// Maintenance offers nothing optional, so it has no heading.
const FAMILIES = () => [
  { family_code: "VSA", provider_id: P, provider_name: "Sample", tiers: [tier("CARE-1", "SAMPLE CARE", [rate("c24", 24, 300, [COMMERCIAL])])] },
  { family_code: "PPM", provider_id: P, provider_name: "Sample", tiers: [tier("PPM-1", "SAMPLE MAINT", [rate("m12", 12, 100, [])])] },
  { family_code: "TAW", provider_id: P, provider_name: "Sample", tiers: [tier("TW-1", "SAMPLE TIRE", [rate("t36", 36, 200, [CHROME, COMMERCIAL])])] },
  { family_code: "BAT", provider_id: P, provider_name: "Sample", tiers: [tier("BAT-1", "SAMPLE BATTERY", [rate("b120", 120, 60, [...BATTERIES, LITHIUM])])] },
];
const CATALOG = [
  { provider_id: P, product_code: "CARE-1", display_name: "Sample Care", category: "Mechanical Protection", display_order: 110 },
  { provider_id: P, product_code: "PPM-1", display_name: "Sample Maintenance", category: "Maintenance", display_order: 100 },
  { provider_id: P, product_code: "TW-1", display_name: "Sample Tire and Wheel", category: "Tire and Wheel", display_order: 120 },
  { provider_id: P, product_code: "BAT-1", display_name: "Sample Battery", category: "Battery", display_order: 140 },
];
const RULES = [{ id: "r", tenant_id: "t", store_id: null, provider_id: null, product_code: null, cost_floor: 0, cost_ceiling: 9999,
  markup_percent: 50, markup_min_dollars: 0, markup_max_dollars: null, round_to: 0, active: true, max_markup_percent: 80, max_markup_dollars: null }];
const COLUMNS = [{ name: "Gold", preset_categories: ["Mechanical Protection", "Maintenance", "Tire and Wheel", "Battery"], starting_level: "Highest" }];
const sheetWith = (surcharges = []) => buildSheet({
  families: priceFamilies(FAMILIES(), RULES), catalog: CATALOG, rules: RULES, columns: COLUMNS, presets: [],
  prepared: null, prices: {}, surcharges, purchased: new Set(), purchased_prices: {},
});
const BATTERY_PICKER = () => sheetWith().surcharges.groups.find((g) => g.category === "Battery").items.find((i) => i.kind === "count");

test("grouped by category, in menu row order, each with only its own surcharges", () => {
  const sheet = sheetWith();
  assert.deepEqual(sheet.categories, ["Mechanical Protection", "Maintenance", "Tire and Wheel", "Battery"]);
  assert.deepEqual(sheet.surcharges.groups.map((g) => g.category), ["Mechanical Protection", "Tire and Wheel", "Battery"]);
  const labels = (cat) => sheet.surcharges.groups.find((g) => g.category === cat).items.map((i) => i.label);
  assert.deepEqual(labels("Mechanical Protection"), ["Commercial Use"]);
  assert.deepEqual(labels("Tire and Wheel"), ["Chrome/Aftermarket Wheels", "Commercial Use"]);
  assert.deepEqual(labels("Battery"), ["Additional batteries", "Lithium Battery"]);
});

test("a shared surcharge checked under one heading is checked under the other, with a note", () => {
  const sheet = sheetWith();
  const groups = sheet.surcharges.groups;
  const under = (cat) => groups.find((g) => g.category === cat).items.find((i) => i.kind === "one" && i.code === "COMMERCIAL");
  let state = model.initialState(sheet);
  state = model.toggleSurcharge(state, under("Tire and Wheel").code);
  // One setting: both headings read the same.
  assert.ok(state.surcharges.includes(under("Mechanical Protection").code));
  assert.ok(state.surcharges.includes(under("Tire and Wheel").code));
  assert.deepEqual(state.surcharges, ["COMMERCIAL"]);
  assert.equal(model.alsoAppliesTo(groups, "Mechanical Protection", under("Mechanical Protection")), "Also applies to Tire and Wheel");
  assert.equal(model.alsoAppliesTo(groups, "Tire and Wheel", under("Tire and Wheel")), "Also applies to Mechanical Protection");
  assert.equal(model.alsoAppliesTo(groups, "Battery", BATTERY_PICKER()), null);
  // Off under one is off under both.
  assert.deepEqual(model.toggleSurcharge(state, "COMMERCIAL").surcharges, []);
  // Pricing stays per product, each at its own dealer cost.
  const priced = sheetWith(["COMMERCIAL"]);
  const surchargeOf = (cat) => priced.plans[cat][0].options[0].surcharge_cost;
  assert.deepEqual([surchargeOf("Mechanical Protection"), surchargeOf("Tire and Wheel")], [4000, 4000]);
});

test("the battery counts are one picker, None and 1 to 7, and send exactly one option", () => {
  const picker = BATTERY_PICKER();
  assert.equal(picker.label, "Additional batteries");
  assert.deepEqual(picker.choices.map((c) => c.count), [1, 2, 3, 4, 5, 6, 7]);
  const sheet = sheetWith();
  let state = model.initialState(sheet);
  state = model.setCount(state, picker, "Add_2_Battery");
  state = model.setCount(state, picker, "Add_5_Battery");
  assert.deepEqual(state.surcharges, ["Add_5_Battery"]);
  assert.equal(model.countChosen(state, picker), "Add_5_Battery");
  // Lithium is a different battery, not a count: it stays beside the picker.
  state = model.toggleSurcharge(state, "Lithium");
  assert.deepEqual(model.setCount(state, picker, "Add_3_Battery").surcharges.sort(), ["Add_3_Battery", "Lithium"]);
  assert.deepEqual(model.setCount(state, picker, null).surcharges, ["Lithium"]);
  // What Prepare sends: one count, accepted.
  const sent = model.payloadOf(sheet, model.setCount(state, picker, "Add_3_Battery"), false).surcharges;
  assert.deepEqual(sent.filter((c) => c.startsWith("Add_")), ["Add_3_Battery"]);
  assert.deepEqual(checkPreparation(sheet, { cells: {}, prices: {}, surcharges: sent }).errors, []);
  // Two counts never get through the server.
  assert.deepEqual(checkPreparation(sheet, { cells: {}, prices: {}, surcharges: ["Add_1_Battery", "Add_4_Battery"] }).errors,
    ["Choose one number of additional batteries."]);
});

test("only plain counts of one item are grouped", () => {
  assert.deepEqual(countGroups(["Add_1_Battery", "Lithium", "HVAC"]), []);
  assert.deepEqual(countGroups(["Add_1_Battery", "Add_2_Battery", "Add_1_Winch"]).map((g) => g.label), ["Additional batteries"]);
  assert.deepEqual(countGroups(["Add_2_Seat", "Add_3_Seat"]).map((g) => [g.label, g.choices.map((c) => c.count)]), [["Additional seats", [2, 3]]]);
});

test("Submit receives the provider's own option code, unchanged", () => {
  const sheet = sheetWith(["Add_3_Battery", "COMMERCIAL"]);
  // Present menu starts from the prepared surcharges.
  const families = priceFamilies(FAMILIES(), RULES);
  const rows = menu.buildRows(families.map((f) => ({ ...f, tiers: f.tiers.map((t) => ({ ...t, available: true })) })),
    CATALOG.map((c) => ({ ...c, is_presentable: true })), [], []);
  const cells = menu.preparedCells(rows, COLUMNS, preparedForMenu(sheet));
  const decisions = menu.saveDecisions(rows, cells[0], "2026-10-31T12:00:00Z").filter((d) => d.disposition === "Included");
  const battery = decisions.find((d) => d.product_code === "BAT-1");
  assert.deepEqual(battery.selected_options, ["Add_3_Battery"]);
  // The quote as rated, with every option the provider offered.
  const quoteOpt = (o) => ({ unique: o.code, label: o.label, dealerCost: { amount: o.cost_delta }, mandatory: false, selected: false });
  const quote = { quote: { vehicles: [{ products: [
    { unique: "BAT-1", label: "SAMPLE BATTERY", ptype: "BAT", rates: [{ unique: "b120", termMonths: 120, options: [...BATTERIES, LITHIUM].map(quoteOpt) }] },
  ] }] } };
  const { quote: out } = buildSubmitQuote(quote, [{ product_unique: "BAT-1", rate_unique: "b120", option_uniques: battery.selected_options, retail_price: 150 }]);
  const sentOptions = out.vehicles[0].products[0].rates[0].options;
  assert.deepEqual(sentOptions.map((o) => o.unique), ["Add_3_Battery"]);
  assert.equal(sentOptions[0].label, "Add Three Batteries");
});

test("the dialog renders groups, the picker and the note, and fits in two columns", () => {
  const view = read("apps/ownership-planner/app/prepare/[sessionId]/Prepare.tsx");
  assert.match(view, /<h3>\{g\.category\}<\/h3>/);
  assert.match(view, /<option value="">None<\/option>/);
  assert.match(view, /setCount\(s, item, e\.target\.value \|\| null\)/);
  assert.match(view, /alsoAppliesTo\(groups, g\.category, item\)/);
  assert.match(view, /pm-surcharge-groups--two/);
  const css = read("apps/ownership-planner/app/prepare/[sessionId]/prepare.css");
  assert.match(css, /\.pm-surcharge-groups--two \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
});
