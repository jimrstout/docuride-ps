// The default deductible applied (6 Nov 2026): whenever PS picks a rate line
// for a product that offers deductibles, and staff have not chosen one, it
// picks the line at Administration's Default deductible. With none at that
// term, nothing is put in its place: the product shows a notice and waits for
// staff, and Save stays blocked for it. Products without deductibles are
// picked as before. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as shared from "../supabase/functions/_shared/default-deductible.ts";
import * as app from "../apps/ownership-planner/lib/default-deductible.ts";
import { buildSheet, checkPreparation, preparedForMenu } from "../supabase/functions/_shared/menu-prepare.ts";
import { customerPriceFor } from "../supabase/functions/_shared/plan-prices.ts";
import * as prep from "../apps/ownership-planner/lib/prepare-model.ts";
import * as menu from "../apps/ownership-planner/lib/menu-model.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const P = "prov-1";
const CODE = { "0|false": "0 Ded", "50|false": "50 Ded", "100|true": "100 Dis Ded" };
const line = (id, months, deductible, disappearing, cost, code = CODE[`${deductible}|${disappearing}`]) => ({
  rate_unique_id: id, term_months: months, term_miles: 0, deductible, deductible_code: code, disappearing_deductible: disappearing,
  dealer_cost: cost, provider_markup: 0, offered_price: null, options: [], raw: {}, retail_price: cost * 1.5,
});
const plain = (id, months, cost) => line(id, months, 0, false, cost, "");
// A service contract the provider offers at three deductibles, sorted as the
// normalizer sorts them: by term, then the smallest deductible first. At 48
// months it offers no $100 disappearing deductible.
const CARE = [
  line("c12-0", 12, 0, false, 300), line("c12-50", 12, 50, false, 280), line("c12-100d", 12, 100, true, 260),
  line("c48-0", 48, 0, false, 500), line("c48-50", 48, 50, false, 480),
];
const TIRE = [plain("t24", 24, 100), plain("t36", 36, 140)];
const FAMILIES = [
  { family_code: "VSA", provider_id: P, tiers: [{ product_code: "CARE-1", product_name: "SAMPLE CARE", product_type: "VSA", provider_id: P, rates: CARE, raw: {} }] },
  { family_code: "TW", provider_id: P, tiers: [{ product_code: "TW-1", product_name: "SAMPLE TIRE", product_type: "TW", provider_id: P, rates: TIRE, raw: {} }] },
];
const CATALOG = [
  { provider_id: P, product_code: "CARE-1", display_name: "Sample Care", category: "Mechanical Protection", display_order: 110 },
  { provider_id: P, product_code: "TW-1", display_name: "Sample Tire", category: "Tire and Wheel", display_order: 120 },
];
const RULES = [{ id: "r", tenant_id: "t", store_id: null, provider_id: null, product_code: null, cost_floor: 0, cost_ceiling: 9999,
  markup_percent: 50, markup_min_dollars: 0, markup_max_dollars: null, round_to: 0, active: true, max_markup_percent: null, max_markup_dollars: null }];
const COLUMNS = [{ name: "Gold", preset_categories: ["Mechanical Protection", "Tire and Wheel"], starting_level: "Lowest" }];
const MP = "Mechanical Protection";
const sheetWith = (over = {}) => buildSheet({ families: FAMILIES, catalog: CATALOG, rules: RULES, columns: COLUMNS, presets: [],
  prepared: null, prices: {}, surcharges: [], purchased: new Set(), purchased_prices: {}, ...over });
const optionOf = (sheet, key) => Object.values(sheet.plans).flat().flatMap((p) => p.options).find((o) => o.key === key);
const NOTICE = "No $100 disappearing deductible is offered for this term. Choose a deductible.";

// ── The pick itself ─────────────────────────────────────────────────────────
test("the default line at the term; none there and nothing in its place; no deductibles and the first, as before", () => {
  for (const m of [shared, app]) {
    assert.equal(m.defaultLineFor(CARE, 12, "$100 disappearing deductible").rate_unique_id, "c12-100d");
    assert.equal(m.defaultLineFor(CARE, 48, "$100 disappearing deductible"), null);
    assert.equal(m.defaultLineFor(CARE, 48, "$50 deductible").rate_unique_id, "c48-50");
    assert.equal(m.defaultLineFor(CARE, 12, "No deductible").rate_unique_id, "c12-0");
    assert.equal(m.defaultLineFor(TIRE, 36, "$100 disappearing deductible").rate_unique_id, "t36");
    assert.equal(m.defaultLineFor(TIRE, 24, "$100 disappearing deductible").rate_unique_id, "t24");
    assert.equal(m.hasDeductibleLines(TIRE), false);
    // A price sheet's "$0 deductible" on every line is no deductible choice.
    const sheetOnly = [line("s12", 12, 0, false, 100, "$0 deductible"), line("s24", 24, 0, false, 150, "$0 deductible")];
    assert.equal(m.hasDeductibleLines(sheetOnly), false);
    assert.equal(m.defaultLineFor(sheetOnly, 24, "$100 disappearing deductible").rate_unique_id, "s24");
    assert.equal(m.noDefaultNotice("$100 disappearing deductible"), NOTICE);
    assert.equal(m.noDefaultNotice("$50 deductible"), "No $50 deductible is offered for this term. Choose a deductible.");
    // A negative amount from a provider is read as no deductible, never as -1.
    assert.equal(m.isDeductible({ term_months: 12, deductible: -1, disappearing_deductible: false }, { amount: 0, disappearing: false }), true);
  }
});

test("the app's copy is the same code as the Edge Functions'", () => {
  const body = (src, name) => {
    const at = src.indexOf(`export function ${name}`);
    return src.slice(at, src.indexOf("\n}\n", at)).replace(/\s+/g, " ");
  };
  const s = read("supabase/functions/_shared/default-deductible.ts");
  const a = read("apps/ownership-planner/lib/default-deductible.ts");
  for (const name of ["parseDeductible", "hasDeductibleLines", "isDeductible", "noDefaultNotice", "defaultLineFor"]) {
    assert.equal(body(a, name), body(s, name), name);
  }
  assert.equal(app.DEFAULT_DEDUCTIBLE, shared.DEFAULT_DEDUCTIBLE);
  assert.deepEqual([...app.DEDUCTIBLE_CHOICES], [...shared.DEDUCTIBLE_CHOICES]);
});

// ── Prepare presentation ────────────────────────────────────────────────────
test("Prepare starts a product with deductibles on the default, and others as before", () => {
  const sheet = sheetWith({ term_basis: { financed: true, months: 12 } });
  assert.equal(optionOf(sheet, sheet.cells["1"][MP].key).rate_unique_id, "c12-100d");
  assert.equal(sheet.cells["1"][MP].note, null);
  assert.equal(optionOf(sheet, sheet.cells["1"]["Tire and Wheel"].key).rate_unique_id, "t24");
  assert.equal(sheet.default_deductible, "$100 disappearing deductible");
  // Another setting is followed.
  const fifty = sheetWith({ term_basis: { financed: true, months: 12 }, default_deductible: "$50 deductible" });
  assert.equal(optionOf(fifty, fifty.cells["1"][MP].key).rate_unique_id, "c12-50");
});

test("no default at the term: no other deductible, a notice at the product, and Save blocked for it", () => {
  const sheet = sheetWith({ term_basis: { financed: true, months: 48 } });
  const cell = sheet.cells["1"][MP];
  assert.deepEqual(cell, { key: null, note: NOTICE, choose: { provider_id: P, product_code: "CARE-1" } });
  // The menu is told, so it shows the notice too.
  assert.deepEqual(preparedForMenu(sheet).choose["1"][MP], { provider_id: P, product_code: "CARE-1", note: NOTICE });

  // The screen: blocked, and the waiting cell is not sent.
  const state = prep.initialState(sheet);
  assert.equal(prep.saveBlocked(sheet, state), true);
  assert.equal(MP in prep.payloadOf(sheet, state).cells["1"], false);
  // The server refuses it as sent.
  const refused = checkPreparation(sheet, { ...prep.payloadOf(sheet, state), prices: {} });
  assert.deepEqual(refused.errors, [`Gold, ${MP}: ${NOTICE}`]);

  // Staff choose a deductible: no longer blocked, and the server takes it.
  const chosen = prep.setCellIn(state, "1", MP, Object.values(sheet.plans).flat()[0].options.find((o) => o.rate_unique_id === "c48-50").key);
  assert.equal(prep.saveBlocked(sheet, chosen), false);
  assert.deepEqual(checkPreparation(sheet, { ...prep.payloadOf(sheet, chosen), prices: {} }).errors, []);
  // Or leave the product out of the column: also a choice.
  const left = prep.setCellIn(state, "1", MP, null);
  assert.equal(prep.saveBlocked(sheet, left), false);
  assert.deepEqual(checkPreparation(sheet, { ...prep.payloadOf(sheet, left), prices: {} }).errors, []);
});

test("an admin preset that names a deductible keeps its own closest pick", () => {
  const presets = [{ column_position: 1, category: MP, provider_id: null, plan_name: null, term_months: 48, term_miles: null, deductible: 0, disappearing_deductible: false }];
  const sheet = sheetWith({ presets, term_basis: { financed: true, months: 48 } });
  assert.equal(optionOf(sheet, sheet.cells["1"][MP].key).rate_unique_id, "c48-0");
});

test("a deductible staff saved is kept as saved", () => {
  const first = sheetWith({ term_basis: { financed: true, months: 12 } });
  const zero = Object.values(first.plans).flat()[0].options.find((o) => o.rate_unique_id === "c12-0").key;
  const sheet = sheetWith({ term_basis: { financed: true, months: 12 }, prepared: { "1": { [MP]: zero } } });
  assert.equal(sheet.cells["1"][MP].key, zero);
});

// ── Present menu and the planner ────────────────────────────────────────────
const rows = () => menu.buildRows(FAMILIES, CATALOG.map((c) => ({ ...c, is_presentable: true })), [], []);

test("the menu starts a product on the default; without one at the term it waits, unpriced, with the notice", () => {
  const [care, tire] = rows();
  const cell = menu.initialCell(care, COLUMNS[0]);
  assert.equal(cell.rate, "c12-100d");
  assert.equal(menu.initialCell(tire, COLUMNS[0]).rate, "t24");
  // The setting picks a line at the shortest term; "$250 deductible" has none there.
  const waits = menu.initialCell(care, COLUMNS[0], "$250 deductible");
  assert.equal(waits.checked, false);
  assert.equal(waits.choose, "No $250 deductible is offered for this term. Choose a deductible.");
  assert.equal(menu.rateOf(care, waits, "$250 deductible"), undefined);
  assert.equal(menu.cellPrice(care, waits, "$250 deductible"), null);
  // A waiting cell from Prepare: on its plan, with the notice, never included.
  const sheet = sheetWith({ term_basis: { financed: true, months: 48 } });
  const [cells] = menu.preparedCells(rows(), COLUMNS, preparedForMenu(sheet));
  assert.equal(cells[0].choose, NOTICE);
  assert.equal(cells[0].tier, "CARE-1");
  const saved = menu.saveDecisions(rows(), [{ ...cells[0], checked: true }, cells[1]], "2026-11-06T12:00:00Z");
  assert.equal(saved.find((d) => d.product_code === "CARE-1").disposition, "Managed by Customer");
  // A tier not taken is recorded on its starting line, never a deductible nobody chose.
  assert.equal(menu.saveDecisions(rows(), [{ ...cell, checked: false }, cells[1]], "x").find((d) => d.product_code === "CARE-1").rate_unique_id, "c12-100d");
});

test("the server never prices a deductible nobody chose, and refuses to save one included without it", () => {
  assert.equal(customerPriceFor(FAMILIES, "CARE-1", null, [], P), null);
  assert.equal(customerPriceFor(FAMILIES, "TW-1", null, [], P), 150);
  const save = read("supabase/functions/fni-session-save/index.ts");
  assert.match(save, /if \(d\.disposition !== "Included" \|\| d\.rate_unique_id\) return false;/);
  assert.match(save, /return json\(400, \{ error: `Choose a deductible for \$\{/);
});

test("every screen that picks a line itself uses the default, and never puts another deductible in its place", () => {
  const planner = read("apps/ownership-planner/app/plan/[sessionId]/Planner.tsx");
  assert.match(planner, /defaultLineFor\(t\.tier\.rates, t\.tier\.rates\[0\]\?\.term_months \?\? null, deductibleSetting\) \?\?\s*undefined,/);
  assert.match(planner, /if \(d === "Included" && deductibleNotice\) return;/);
  assert.doesNotMatch(planner, /\?\?\s*t\.tier\.rates\[0\],/);
  const m = read("apps/ownership-planner/app/menu/[sessionId]/Menu.tsx");
  assert.match(m, /const c = cellOnTier\(next, editCell\.checked, setting\);/);
  assert.doesNotMatch(m, /next\?\.rates\[0\]/);
  const p = read("apps/ownership-planner/app/prepare/[sessionId]/Prepare.tsx");
  assert.match(p, /const line = defaultLineFor\(plan\.options, months, setting\);/);
  assert.doesNotMatch(p, /plan\.options\[0\]\.key/);
  const chooser = read("apps/ownership-planner/components/RateChooser.tsx");
  assert.match(chooser, /if \(!hasDeductibleChoice\) return inLength\[0\];\s*if \(!dLabel\) return undefined;\s*return inLength\.find\(\(r\) => deductibleLabel\(r\) === dLabel\);/);
  // The setting reaches every screen with the deal.
  assert.match(read("supabase/functions/_shared/menu-prepare-rows.ts"), /readDefaultDeductible\(supabase, s\.tenant_id\),/);
  assert.match(read("supabase/functions/fni-session-get/index.ts"), /default_deductible: defaultDeductible,/);
});
