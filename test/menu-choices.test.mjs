// The customer's own product choices during the presentation (docs section
// 26, migration 0046): remove a product from a column and add it back before
// choosing; removed stays in view, dimmed; purchased cannot be removed; the
// choice records what was kept and removed, with one event; the
// acknowledgment says so. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as menu from "../apps/ownership-planner/lib/menu-model.ts";
import { packageChosenEvent } from "../supabase/functions/_shared/menu-terms.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const P = "prov-1";
const rate = (id, months, retail) => ({ rate_unique_id: id, term_months: months, term_miles: 0, deductible: 0, dealer_cost: retail / 2, retail_price: retail, options: [], raw: {} });
const fam = (code, rates) => ({ family_code: code, provider_id: P, tiers: [{ product_code: code, product_name: code, product_type: "X", provider_id: P, rates, raw: {} }] });
const FAMILIES = [fam("CARE", [rate("c24", 24, 450)]), fam("TW", [rate("t36", 36, 350)]), fam("BAT", [rate("b120", 120, 145)])];
const CATALOG = [["CARE", "Mechanical Protection"], ["TW", "Tire and Wheel"], ["BAT", "Battery"]]
  .map(([c, cat]) => ({ provider_id: P, product_code: c, category: cat, display_name: `Sample ${cat}`, is_presentable: true }));
const COLUMNS = [{ name: "Gold", preset_categories: ["Mechanical Protection", "Tire and Wheel", "Battery"], starting_level: "Lowest" }];

test("removing a product changes that column's total and nothing else's price; adding it back restores it", () => {
  const rows = menu.buildRows(FAMILIES, CATALOG, [], []);
  const cells = menu.initialCells(rows, COLUMNS)[0];
  assert.deepEqual(menu.columnPrices(rows, cells), [450, 350, 145]);
  const removed = cells.map((c, i) => (rows[i].category === "Tire and Wheel" ? { ...c, checked: false } : c));
  assert.deepEqual(menu.columnPrices(rows, removed), [450, 145]);
  // The removed product is declined on the save; the rest keep their prices.
  const saved = menu.saveDecisions(rows, removed, "2026-10-30T12:00:00Z");
  assert.deepEqual(saved.map((d) => [d.product_code, d.disposition, d.customer_price]), [
    ["CARE", "Included", 450], ["TW", "Managed by Customer", 350], ["BAT", "Included", 145],
  ]);
  assert.deepEqual(menu.columnPrices(rows, cells), [450, 350, 145]);
});

test("a purchased product cannot be removed", () => {
  const rows = menu.buildRows(FAMILIES, CATALOG, [{ provider_id: P, provider_product_id: "BAT" }], [
    { provider_id: P, provider_product_id: "BAT", rate_unique_id: "b120", selected_options: [], customer_price: 145 },
  ]);
  assert.equal(menu.cellLocked(rows[2]), true);
  const m = read("apps/ownership-planner/app/menu/[sessionId]/Menu.tsx");
  assert.match(m, /const removable = \(ci: number, ri: number\) => baseline\[ci\]\?\.\[ri\]\?\.checked === true && !rows\[ri\]\.purchased;/);
});

test("removed stays in view, dimmed, with Add back; kept on the session without events; reset from Prepare menu", () => {
  const m = read("apps/ownership-planner/app/menu/[sessionId]/Menu.tsx");
  assert.match(m, /\$\{isRemoved\(ci, ri\) \? "is-removed" : ""\}/);
  assert.match(m, /\{cell\.checked \? "Remove" : "Add back"\}/);
  assert.match(m, /body: JSON\.stringify\(\{ menu_removed \}\),/);
  assert.match(m, /removed: column === null \? \[\] : removedIn\(column - 1\),/);
  const css = read("apps/ownership-planner/app/menu/[sessionId]/menu.css");
  assert.match(css, /\.mn-cell\.is-removed \.mn-cap, \.mn-cell\.is-removed \.mn-cell-price \{ opacity: 0\.45; text-decoration: line-through; \}/);
  const save = read("supabase/functions/fni-session-save/index.ts");
  assert.match(save, /if \(body\.menu_removed !== undefined && !\(session as unknown as Record<string, unknown>\)\.menu_prices_locked_at\) \{\s*patch\.menu_removed = removedFrom\(body\.menu_removed\);/);
  // Only known categories, columns 1 to 5; no event for a tap.
  assert.match(save, /if \(!\/\^\[1-5\]\$\/\.test\(pos\) \|\| !Array\.isArray\(list\)\) continue;/);
  assert.doesNotMatch(save, /recordEvent\([^)]*menu_removed/);
  assert.match(read("supabase/functions/fni-menu-prepare/index.ts"), /\.update\(\{ menu_removed: null \}\)/);
});

test("one event on the package choice, signed by the presenter, naming what was removed", () => {
  assert.equal(packageChosenEvent("Gold", { months: 72, rate: 7.74, deal_term: false }, ["Tire and Wheel", "Battery"]),
    "Package chosen: Gold, 72 months at 7.74%. Removed: Tire and Wheel, Battery.");
  const save = read("supabase/functions/fni-session-save/index.ts");
  assert.match(save, /const removed = \(menuEvent\.removed \?\? \[\]\)\.filter\(\(c\) => known\.has\(c\)\);/);
  assert.match(save, /created_by: signedBy\(body\.presented_by\)/);
});

test("the acknowledgment lists what was kept and declined, removed ones as removed, on the term chosen", () => {
  const ack = read("supabase/functions/fni-acknowledgment/index.ts");
  assert.match(ack, /removed_from: removed && d\.disposition !== "Included" \? choice!\.name! : null,/);
  assert.match(ack, /term_months: chosenTerm \? chosenTerm\.months : numOr\(s\.finance_term_total\),/);
  const pdf = read("supabase/functions/_shared/acknowledgment-pdf.ts");
  assert.match(pdf, /`\$\{d\.disposition\}\. Removed from the \$\{d\.removed_from\} package`/);
});
