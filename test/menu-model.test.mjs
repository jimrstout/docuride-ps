// The conventional menu's grid (2026-10-30): every rated product in every
// column, presets by category, coverage levels, purchased products locked,
// live totals by the planner's own payment math, and the same saved rows the
// planner writes. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PURCHASED,
  UNAVAILABLE,
  buildRows,
  cellPrice,
  columnPrices,
  declinedCells,
  initialCell,
  initialCells,
  levelIndex,
  saveDecisions,
} from "../apps/ownership-planner/lib/menu-model.ts";
import { levelIndex as sharedLevelIndex } from "../supabase/functions/_shared/menu-columns.ts";
import { planTotals, toCents } from "../apps/ownership-planner/lib/money.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const P = "11111111-1111-4111-8111-111111111111";

const rate = (id, price, over = {}) => ({
  rate_unique_id: id, term_months: 36, term_miles: 0, deductible: 0, dealer_cost: price === null ? null : price / 2,
  retail_price: price, options: [], raw: { unique: id }, ...over,
});
const tier = (code, name, rates) => ({ product_code: code, product_name: name, product_type: code, rates, raw: {} });

const families = [
  {
    family_code: "CARE", provider_id: P,
    tiers: [
      tier("CARE-GOLD", "SAMPLE CARE GOLD", [rate("g1", 1500.0), rate("g2", 1800.0, { term_months: 48 })]),
      tier("CARE-BRONZE", "SAMPLE CARE BRONZE", [rate("b1", 900.0)]),
      tier("CARE-SILVER", "SAMPLE CARE SILVER", [rate("s1", 1200.0)]),
    ],
  },
  { family_code: "TIRE", provider_id: P, tiers: [tier("TIRE", "SAMPLE TIRE", [rate("t1", 499.99, { options: [{ code: "LIFT", label: "Lift kit", cost_delta: 50, mandatory: false }, { code: "COMM", label: "Commercial", cost_delta: 25.01, mandatory: true }] })])] },
  { family_code: "THEFT", provider_id: P, tiers: [tier("THEFT", "SAMPLE THEFT RAW NAME", [rate("x1", 299.0)])] },
  { family_code: "PAINT", provider_id: P, tiers: [tier("PAINT", "SAMPLE PAINT", [rate("p1", null)])] },
];
const catalog = [
  { provider_id: P, product_code: "CARE-GOLD", category: "Mechanical Protection", display_name: "Care Gold", is_presentable: true },
  { provider_id: P, product_code: "CARE-SILVER", category: "Mechanical Protection", display_name: "Care Silver", is_presentable: true },
  { provider_id: P, product_code: "CARE-BRONZE", category: "Mechanical Protection", display_name: "Care Bronze", is_presentable: true },
  { provider_id: P, product_code: "TIRE", category: "Tire and Wheel", display_name: "Tire and Wheel", is_presentable: true },
  // No approved description: shown under the provider's product name.
  { provider_id: P, product_code: "THEFT", category: "Theft", display_name: "Theft Protection", is_presentable: false },
  { provider_id: P, product_code: "PAINT", category: "Appearance", display_name: "Paint", is_presentable: true },
];
const columns = [
  { name: "Platinum", preset_categories: ["Mechanical Protection", "Tire and Wheel", "Theft", "Appearance"], starting_level: "Highest" },
  { name: "Gold", preset_categories: ["Mechanical Protection", "Tire and Wheel"], starting_level: "Middle" },
  { name: "Basic", preset_categories: ["Mechanical Protection"], starting_level: "Lowest" },
];
const rows = buildRows(families, catalog, [], []);

test("every rated product is in every column, nothing hidden", () => {
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0].tiers.map((t) => t.product_code), ["CARE-BRONZE", "CARE-SILVER", "CARE-GOLD"]);
  assert.equal(rows[0].label, "Mechanical Protection");
  // A product with no approved description shows under its provider product name.
  assert.equal(rows[2].tiers[0].name, "SAMPLE THEFT RAW NAME");
  // A product with no price is shown, as not available.
  assert.equal(rows[3].tiers[0].available, false);
  const cell = initialCell(rows[3], columns[0]);
  assert.equal(cell.checked, false);
  assert.equal(cellPrice(rows[3], cell), null);
  assert.equal(UNAVAILABLE, "Not available");
  for (const col of initialCells(rows, columns)) assert.equal(col.length, rows.length);
});

test("presets by category, at the column's coverage level", () => {
  const cells = initialCells(rows, columns);
  assert.deepEqual(cells.map((c) => c.map((x) => x.checked)), [
    [true, true, true, false],
    [true, true, false, false],
    [true, false, false, false],
  ]);
  assert.deepEqual(cells.map((c) => c[0].tier), ["CARE-GOLD", "CARE-SILVER", "CARE-BRONZE"]);
  // The planner's defaults for the rest: the first rate, no optional options.
  assert.equal(cells[0][0].rate, "g1");
  assert.deepEqual(cells[0][1].options, []);
  // The same level rule as the admin side.
  for (const l of ["Lowest", "Middle", "Highest"]) for (const n of [1, 2, 3, 4, 5]) assert.equal(levelIndex(l, n), sharedLevelIndex(l, n));
});

test("a preset category with no rated product: the column goes without it", () => {
  const onlyTire = buildRows([families[1]], catalog, [], []);
  const cells = initialCells(onlyTire, [{ name: "Basic", preset_categories: ["Mechanical Protection"], starting_level: "Lowest" }]);
  assert.deepEqual(cells[0].map((c) => c.checked), [false]);
});

test("a mandatory surcharge is always counted; an optional one only when chosen", () => {
  const cells = initialCells(rows, columns);
  assert.equal(cellPrice(rows[1], cells[0][1]), 525.0);
  assert.equal(cellPrice(rows[1], { ...cells[0][1], options: ["LIFT"] }), 575.0);
});

test("a change affects that column only", () => {
  const cells = initialCells(rows, columns);
  cells[1][0] = { ...cells[1][0], checked: false };
  assert.equal(cells[0][0].checked, true);
  assert.equal(cells[2][0].checked, true);
  assert.notEqual(cells[0][0], cells[2][0]);
});

test("each column's total and payment are the planner's, to the cent", () => {
  const cells = initialCells(rows, columns);
  const platinum = columnPrices(rows, cells[0]);
  assert.deepEqual(platinum, [1500, 525, 299]);
  assert.equal(toCents(platinum.reduce((a, p) => a + p, 0)), 2324);
  const t = planTotals(15000, platinum, 6.99, 60, null);
  // The same answer as financing the combined amount directly.
  const direct = planTotals(15000 + 2324, [], 6.99, 60, null);
  assert.equal(t.totalPayment, direct.totalPayment);
  assert.equal(toCents(t.vehiclePayment + t.planPayment), t.totalPayment);
  const menu = read("apps/ownership-planner/app/menu/[sessionId]/Menu.tsx");
  assert.match(menu, /const totals = hasPayment \? planTotals\(principal!, prices, rate!, term!, cap\) : null;/);
  // Cash: the total only, no monthly figure.
  assert.match(menu, /\{f\.totals \? \(\s*<span className="mn-month">/);
  assert.match(menu, /const cap = isCash \? null : num\(session\.financials\.max_amount_financed\);/);
});

test("purchased products are checked, locked, at the price they were sold for", () => {
  const bought = buildRows(
    families,
    catalog,
    [{ provider_id: P, provider_product_id: "CARE-SILVER" }],
    [{ provider_id: P, provider_product_id: "CARE-SILVER", rate_unique_id: "s1", selected_options: [], customer_price: "1234.56" }]
  );
  const cell = initialCell(bought[0], columns[2]);
  assert.deepEqual(cell, { checked: true, tier: "CARE-SILVER", rate: "s1", options: [] });
  assert.equal(cellPrice(bought[0], cell), 1234.56);
  // Declining everything keeps what is already purchased.
  const declined = declinedCells(bought, initialCells(bought, columns)[0]);
  assert.deepEqual(declined.map((c) => c.checked), [true, false, false, false]);
  assert.equal(PURCHASED, "Purchased");
});

test("Select this package saves the planner's rows: Included only for the chosen tier of each checked product", () => {
  const cells = initialCells(rows, columns);
  const saved = saveDecisions(rows, cells[1], "2026-10-30T15:00:00.000Z");
  assert.equal(saved.length, 6);
  const by = Object.fromEntries(saved.map((d) => [d.product_code, d]));
  assert.equal(by["CARE-SILVER"].disposition, "Included");
  assert.equal(by["CARE-SILVER"].customer_price, 1200);
  assert.equal(by["CARE-GOLD"].disposition, "Managed by Customer");
  assert.equal(by["TIRE"].disposition, "Included");
  assert.deepEqual(by["TIRE"].selected_options, []);
  assert.equal(by["THEFT"].disposition, "Managed by Customer");
  assert.equal(by["PAINT"].disposition, "Managed by Customer");
  // No price, so no rate to sell: it is recorded as presented, with no rate.
  assert.equal(by["PAINT"].rate_unique_id, null);
  // The keys the planner sends, and nothing else.
  assert.deepEqual(Object.keys(by["TIRE"]).sort(), [
    "customer_price", "dealer_cost", "deductible", "disposition", "presented_at", "product_code", "product_name",
    "product_type", "provider_id", "rate_snapshot", "rate_unique_id", "retail_price", "selected_options", "term_miles", "term_months",
  ]);
  const menu = read("apps/ownership-planner/app/menu/[sessionId]/Menu.tsx");
  assert.match(menu, /apiPath\(`\/api\/session\/\$\{session\.id\}\/save`\)[\s\S]*?complete: true,/);
  assert.match(menu, /apiPath\(`\/api\/session\/\$\{session\.id\}\/acknowledgment`\)/);
});

test("the menu opens straight into the columns, with none of the planner's screens", () => {
  const page = read("apps/ownership-planner/app/menu/[sessionId]/page.tsx");
  const menu = read("apps/ownership-planner/app/menu/[sessionId]/Menu.tsx");
  assert.doesNotMatch(page + menu, /from "[^"]*(OwnershipQuestion|ProgressStepper|Planner|ProductScreen)"/);
  assert.match(page, /offer_status: \{ \.\.\.payload\.offer_status, detail: null \}/);
  assert.doesNotMatch(page + menu, /console\.(log|error)\([^)]*(price|buyer|deal_number)/);
  for (const s of [page, menu]) assert.doesNotMatch(s, /—/);
  const css = read("apps/ownership-planner/app/menu/[sessionId]/menu.css");
  assert.match(css, /height: 100dvh;\s*overflow: hidden;/);
  assert.match(css, /grid-template-rows: auto repeat\(var\(--mn-rows\), minmax\(0, 1fr\)\) auto;/);
});

test("a cell's caption is the level's own word, or the term for a one-level product", async () => {
  const { cellCaption } = await import("../apps/ownership-planner/lib/menu-model.ts");
  const cells = initialCells(rows, columns);
  // Care Bronze, Care Silver, Care Gold: the shared "Care" is taken off.
  assert.deepEqual(cells.map((c) => cellCaption(rows[0], c[0])), ["Gold", "Silver", "Bronze"]);
  // One level: its term.
  assert.equal(cellCaption(rows[1], cells[0][1]), "36 months");
  // A short leftover keeps the word before it: "Level 2", not "2".
  const lv = buildRows(
    [{ family_code: "L", provider_id: P, tiers: [tier("L1", "Plan Level 1", [rate("a", 1)]), tier("L2", "Plan Level 2", [rate("b", 2)])] }],
    [], [], []
  );
  assert.equal(cellCaption(lv[0], { checked: true, tier: "L2", rate: "b", options: [] }), "Level 2");
});

test("every screen size fits: tabs for phones and short windows, the price opens the change dialog", () => {
  const css = read("apps/ownership-planner/app/menu/[sessionId]/menu.css");
  assert.match(css, /@media \(max-width: 760px\), \(max-height: 699px\) \{/);
  assert.match(css, /@media \(min-width: 761px\) and \(max-width: 1200px\) and \(min-height: 700px\) \{/);
  const menu = read("apps/ownership-planner/app/menu/[sessionId]/Menu.tsx");
  assert.match(menu, /className="mn-cell-price"[\s\S]{0,400}?onClick=\{\(\) => openCell\(ci, ri\)\}/);
});
