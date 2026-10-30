// Menu presets (Administration > Menus) and the price band staff may set on a
// deal (migration 0045, docs section 25). Mock data only: every plan, code,
// cost and price here is invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as shared from "../supabase/functions/_shared/menu-presets.ts";
import * as app from "../apps/ownership-planner/lib/menu-labels.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const { resolvePreset, priceBand, checkPrice, parsePresets, optionKey, optionLabel, presetDealType, NOT_OFFERED } = shared;

const rate = (id, months, deductible = 0, disappearing = false, miles = 0) =>
  ({ rate_unique_id: id, term_months: months, term_miles: miles, deductible, disappearing_deductible: disappearing });
const plan = (name, order, rates) => ({ provider_id: "prov-1", product_code: `CODE-${order}`, plan_name: name, display_order: order, rates });
const preset = (over) => ({
  column_position: 1, category: "Maintenance", provider_id: null, plan_name: null,
  term_months: null, term_miles: null, deductible: null, disappearing_deductible: null, ...over,
});

const BRONZE = plan("Sample Maintenance, Bronze", 100, [rate("b12", 12), rate("b24", 24), rate("b36", 36)]);
const SILVER = plan("Sample Maintenance, Silver", 101, [rate("s24", 24), rate("s48", 48)]);
const GOLD_UNRATED = plan("Sample Maintenance, Gold", 102, []);

test("plain English for every option, the same on both sides", () => {
  for (const [m, w] of [[12, "1 year"], [24, "2 years"], [48, "4 years"], [18, "18 months"], [120, "10 years"], [null, "No set term"]]) {
    assert.equal(shared.termLabel(m), w);
    assert.equal(app.termLabel(m), w);
  }
  assert.equal(shared.milesLabel(0), "Unlimited miles");
  assert.equal(shared.milesLabel(36000), "36,000 miles");
  assert.equal(shared.deductibleLabel(100, true), "$100 Disappearing Deductible");
  assert.equal(shared.deductibleLabel(50, false), "$50 Deductible");
  assert.equal(shared.deductibleLabel(0), "No deductible");
  const r = rate("x", 48, 100, true);
  assert.equal(optionLabel(r), "4 years / Unlimited miles, $100 Disappearing Deductible");
  assert.equal(app.optionLabel(r), optionLabel(r));
  for (const f of ["milesLabel", "deductibleLabel"]) {
    for (const v of [0, 50, 100, 250, 12000]) assert.equal(app[f](v, true), shared[f](v, true), `${f}(${v})`);
  }
  // No em dash anywhere in the words.
  for (const f of ["supabase/functions/_shared/menu-presets.ts", "apps/ownership-planner/lib/menu-labels.ts"]) assert.doesNotMatch(read(f), /—/);
});

test("an option has one key on a deal, whatever its rate id", () => {
  assert.equal(optionKey("prov-1", "CODE-100", rate("b24", 24, 100, true)), "prov-1|CODE-100|24|0|100.00|D");
  assert.equal(optionKey("prov-1", "CODE-100", rate("other-id", 24, 100, true)), optionKey("prov-1", "CODE-100", rate("b24", 24, 100, true)));
  assert.notEqual(optionKey("prov-1", "CODE-100", rate("b24", 24, 100, false)), optionKey("prov-1", "CODE-100", rate("b24", 24, 100, true)));
});

test("the preset as rated: the plan and term asked for", () => {
  const r = resolvePreset(preset({ plan_name: SILVER.plan_name, term_months: 48 }), [BRONZE, SILVER]);
  assert.deepEqual([r.plan.plan_name, r.rate.rate_unique_id, r.note], [SILVER.plan_name, "s48", null]);
});

test("fallback 1: the closest term, a tie going to the shorter", () => {
  const r = resolvePreset(preset({ plan_name: BRONZE.plan_name, term_months: 48 }), [BRONZE]);
  assert.equal(r.rate.rate_unique_id, "b36");
  assert.equal(r.note, "The preset is not offered on this vehicle, so the closest is used: 3 years / Unlimited miles, No deductible.");
  // 30 months: 24 and 36 are both six away; the shorter wins.
  assert.equal(resolvePreset(preset({ plan_name: BRONZE.plan_name, term_months: 30 }), [BRONZE]).rate.rate_unique_id, "b24");
  // Then the deductible, and its type when asked for.
  const care = plan("Sample Care", 110, [rate("c0", 24, 0), rate("c100s", 24, 100), rate("c100d", 24, 100, true)]);
  assert.equal(resolvePreset(preset({ category: "Mechanical Protection", plan_name: "Sample Care", term_months: 24, deductible: 100, disappearing_deductible: true }), [care]).rate.rate_unique_id, "c100d");
  assert.equal(resolvePreset(preset({ category: "Mechanical Protection", plan_name: "Sample Care", term_months: 24, deductible: 100, disappearing_deductible: false }), [care]).rate.rate_unique_id, "c100s");
});

test("fallback 2: a plan that did not rate gives the next lower plan, never a higher one", () => {
  const r = resolvePreset(preset({ plan_name: GOLD_UNRATED.plan_name, term_months: 48 }), [BRONZE, SILVER, GOLD_UNRATED]);
  assert.deepEqual([r.plan.plan_name, r.rate.rate_unique_id], [SILVER.plan_name, "s48"]);
  assert.equal(r.note, "Sample Maintenance, Gold did not rate on this vehicle, so Sample Maintenance, Silver is offered.");
  // Nothing at or below it rated: an empty cell with a plain note, not the higher plan.
  const lowestMissing = resolvePreset(preset({ plan_name: "Sample Maintenance, Bronze", term_months: 12 }), [plan("Sample Maintenance, Bronze", 100, []), SILVER]);
  assert.deepEqual([lowestMissing.plan, lowestMissing.rate], [null, null]);
  assert.equal(lowestMissing.note, "Sample Maintenance, Bronze and the plans below it are not offered on this vehicle.");
});

test("fallback 3: nothing in the category rated, so the cell is empty and says so", () => {
  assert.deepEqual(resolvePreset(preset({ plan_name: BRONZE.plan_name }), [GOLD_UNRATED]), { plan: null, rate: null, note: NOT_OFFERED });
  assert.equal(NOT_OFFERED, "Not offered on this vehicle");
});

test("no preferred plan: the column's level decides, and the term still picks the rate", () => {
  const r = resolvePreset(preset({ term_months: 48 }), [BRONZE, SILVER], SILVER);
  assert.deepEqual([r.plan.plan_name, r.rate.rate_unique_id], [SILVER.plan_name, "s48"]);
});

test("a deal's type as presets name it: Cash, or Financed for a loan or lease", () => {
  assert.equal(presetDealType("Cash"), "Cash");
  assert.equal(presetDealType("Loan"), "Financed");
  assert.equal(presetDealType("Lease"), "Financed");
  assert.equal(presetDealType(null), "Financed");
});

test("the band: never below dealer cost, the minimum markup up to the maximum, to the cent", () => {
  // Cost $300.00, rule retail $400.00, at least $25, up to 40% or $150.
  const band = priceBand(300, 400, { markup_min_dollars: 25, max_markup_percent: 40, max_markup_dollars: 150 });
  assert.deepEqual(band, { floor: 32500, top: 42000 });
  // The rule's own price is never above the top: the default never needs a manager.
  assert.deepEqual(priceBand(300, 450, { max_markup_percent: 40 }), { floor: 30000, top: 45000 });
  // Percent only, dollars only, neither (the rule's own retail is the top).
  assert.deepEqual(priceBand(300, 450, { max_markup_percent: 60 }), { floor: 30000, top: 48000 });
  assert.deepEqual(priceBand(300, 350, { max_markup_dollars: 75.5 }), { floor: 30000, top: 37550 });
  assert.deepEqual(priceBand(300, 450, {}), { floor: 30000, top: 45000 });
  // An odd cost keeps its cents: 33.3% of $199.99 is $66.60 (66.597 rounded).
  assert.deepEqual(priceBand(199.99, null, { max_markup_percent: 33.3 }), { floor: 19999, top: 26659 });

  assert.deepEqual(checkPrice(40000, 300, band), { ok: true, above_band: false });
  assert.deepEqual(checkPrice(42001, 300, band), { ok: true, above_band: true });
  assert.deepEqual(checkPrice(29999, 300, band), { ok: false, reason: "A price cannot be below dealer cost." });
  assert.deepEqual(checkPrice(31000, 300, band), { ok: false, reason: "The price is below the lowest this product may be sold for." });
  assert.equal(checkPrice(400.5, 300, band).ok, false);
});

test("presets from the form: blank cells are no preset; bad values are refused in plain English", () => {
  const names = new Set([BRONZE.plan_name, SILVER.plan_name]);
  const ok = parsePresets({ p_1_1_plan: SILVER.plan_name, p_1_1_term: "48", p_1_1_miles: "0", p_1_1_deductible: "", p_1_1_kind: "", p_2_0_term: "" }, 2, names);
  assert.deepEqual(ok.presets, [{
    column_position: 1, category: "Maintenance", provider_id: null, plan_name: SILVER.plan_name,
    term_months: 48, term_miles: 0, deductible: null, disappearing_deductible: null,
  }]);
  const bad = parsePresets({ p_1_1_plan: "Not A Plan", p_2_0_term: "two", p_2_0_kind: "Sometimes" }, 2, names);
  assert.deepEqual(bad.errors, [
    'Column 1, Maintenance: "Not A Plan" is not a plan in the catalog.',
    "Column 2, Mechanical Protection: the term is not a number of months.",
    "Column 2, Mechanical Protection: the deductible type is not one offered.",
  ]);
  // A column beyond the menu's is ignored.
  assert.deepEqual(parsePresets({ p_3_1_term: "12" }, 2, names).presets, []);
});

test("managers only, every change logged first, nothing deleted", () => {
  const t = read("supabase/functions/fni-admin-settings/templates.ts");
  const save = t.slice(t.indexOf('case "save_presets": {'), t.indexOf("default:", t.indexOf('case "save_presets": {')));
  assert.match(save, /^case "save_presets": \{\s*if \(!\(await isManager\(supabase, body\.operator_id\)\)\) return \{ status: 403, body: \{ error: MANAGERS_ONLY \} \};/);
  assert.ok(save.indexOf("await logChanges(") < save.indexOf('.from("menu_presets").upsert('));
  assert.doesNotMatch(t, /\.delete\(/);
  const m = read("supabase/functions/fni-admin-settings/managers.ts");
  assert.match(m, /\.rpc\("is_menu_manager", \{ p_user: operatorId \}\)/);
  assert.match(m, /if \(error\) throw new Error\(`The change could not be recorded, so it was not saved/);
  assert.equal(shared.presetLine({ ...preset({ plan_name: SILVER.plan_name, term_months: 48, term_miles: 0 }) }, "Gold"), "Gold, Maintenance: Sample Maintenance, Silver, 4 years, Unlimited miles");

  const p = read("supabase/functions/fni-admin-settings/pricing.ts");
  assert.match(p, /if \(!\(await isManager\(supabase, body\.operator_id\)\)\) return \{ status: 403, body: \{ error: MANAGERS_ONLY \} \};/);
  for (const a of ['action: ruleId === null ? "Created" : "Changed"', 'action: "Removed"', 'action: "Created" as const']) assert.ok(p.includes(a), a);

  // The page: everyone sees presets; only a manager gets Edit presets.
  const page = read("apps/ownership-planner/app/admin/menus/page.tsx");
  assert.match(page, /const editing = canEdit && params\.presetedit !== undefined;/);
  assert.match(page, /\{canEdit && !editing \? \(/);
  assert.match(page, /edge\.adminTemplates<TemplatesPayload>\(operator\.sub\)/);
  const actions = read("apps/ownership-planner/app/console-actions.ts");
  assert.match(actions, /action: "save_presets", template_id: templateId, deal_type: dealType, presets, updated_by: by, operator_id: operatorId,/);
});

test("the pricing band reads in plain English, and the rule keeps it", async () => {
  const { bandSentence, parseRuleFields } = await import("../supabase/functions/_shared/pricing-admin.ts");
  assert.equal(bandSentence({ max_markup_percent: 40, max_markup_dollars: 150 }), "Staff may price up to 40% or $150 over dealer cost, whichever is lower; above that needs a manager.");
  assert.equal(bandSentence({ max_markup_percent: null, max_markup_dollars: 75 }), "Staff may price up to $75 over dealer cost; above that needs a manager.");
  assert.equal(bandSentence({}), null);
  const r = parseRuleFields({ cost_floor: "0", cost_ceiling: "1000", markup_percent: "50", max_markup_percent: "60", max_markup_dollars: "-1" });
  assert.deepEqual(r.errors, ["Staff may price up to, dollars cannot be negative."]);
});
