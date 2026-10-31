// The staff price range as a manager setting (docs section 29): Administration
// > Pricing. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BAND_NOTICE, parseRuleFields, unreviewedBands } from "../supabase/functions/_shared/pricing-admin.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const page = read("apps/ownership-planner/app/admin/pricing/page.tsx");
const handler = read("supabase/functions/fni-admin-settings/pricing.ts");

test("the band settings are labelled plainly, with one line of help", () => {
  for (const label of ["Staff minimum markup ($ over dealer cost)", "Staff maximum markup (% over dealer cost)", "Staff maximum markup ($ over dealer cost)"]) {
    assert.ok(page.includes(`<span>${label}</span>`), label);
  }
  assert.ok(page.includes("Staff can price between these. Outside them needs a manager."));
  // Managers only; every change logged with who and when.
  assert.match(handler, /if \(!\(await isManager\(supabase, body\.operator_id\)\)\) return \{ status: 403, body: \{ error: MANAGERS_ONLY \} \};/);
  assert.match(handler, /area: "Price band",/);
});

test("the staff maximum cannot sit below the staff minimum", () => {
  const base = { cost_floor: "0", cost_ceiling: "400", markup_percent: "250" };
  assert.deepEqual(parseRuleFields({ ...base, markup_min_dollars: "75", max_markup_dollars: "50" }).errors,
    ["Staff maximum markup cannot be less than the staff minimum markup."]);
  assert.ok("fields" in parseRuleFields({ ...base, markup_min_dollars: "75", max_markup_dollars: "75" }));
  assert.ok("fields" in parseRuleFields({ ...base, markup_min_dollars: "75", max_markup_percent: "40" }));
});

test("the setup-values notice shows until a manager saves each band, then clears", () => {
  assert.equal(BAND_NOTICE, "These pricing bands still have their setup values. Review and save them.");
  const bands = [
    { id: "a", band_reviewed_at: null }, { id: "b", band_reviewed_at: null },
  ];
  assert.equal(unreviewedBands(bands), 2);
  // A manager saves one: still shown for the other.
  bands[0].band_reviewed_at = "2026-11-01T12:00:00Z";
  assert.equal(unreviewedBands(bands), 1);
  bands[1].band_reviewed_at = "2026-11-01T12:05:00Z";
  assert.equal(unreviewedBands(bands), 0);
  // Saving stamps the review; a copy keeps whether its source was reviewed.
  assert.match(handler, /band_reviewed_at: now, band_reviewed_by: updatedBy/);
  assert.match(handler, /band_reviewed_at: r\.band_reviewed_at \?\? null,/);
  assert.match(handler, /band_notice: unreviewedBands\(own\) > 0 \? BAND_NOTICE : null,/);
  assert.match(page, /\{payload\.band_notice \? \(/);
  // The values themselves are never changed for this.
  assert.doesNotMatch(read("supabase/migrations/0047_staff_price_range.sql"), /update fni\.pricing_rules/i);
});

// ── Prepare menu: the range in use ───────────────────────────────────────

import { buildSheet, checkPreparation } from "../supabase/functions/_shared/menu-prepare.ts";
import * as model from "../apps/ownership-planner/lib/prepare-model.ts";

const P = "prov-1";
// Dealer cost $321.00. Staff minimum markup $75 (floor $396.00); staff maximum $599 over (top $920.00).
const RULES = [{ id: "r", tenant_id: "t", store_id: null, provider_id: null, product_code: null, cost_floor: 0, cost_ceiling: 9999,
  markup_percent: 50, markup_min_dollars: 75, markup_max_dollars: null, round_to: 0, active: true, max_markup_percent: null, max_markup_dollars: 599 }];
const FAMILIES = [{ family_code: "VSA", provider_id: P, provider_name: "Sample", tiers: [{ product_code: "CARE-1", product_name: "SAMPLE CARE",
  product_type: "VSA", provider_id: P, raw: {}, rates: [{ rate_unique_id: "c24", term_months: 24, term_miles: 0, deductible: 0, deductible_code: null,
    disappearing_deductible: false, dealer_cost: 321, provider_markup: 0, offered_price: null, options: [], raw: {}, retail_price: 481.5 }] }] }];
const CATALOG = [{ provider_id: P, product_code: "CARE-1", display_name: "Sample Care", category: "Mechanical Protection", display_order: 110 }];
const sheet = buildSheet({ families: FAMILIES, catalog: CATALOG, rules: RULES, columns: [{ name: "Gold", preset_categories: ["Mechanical Protection"], starting_level: "Highest" }],
  presets: [], prepared: null, prices: {}, surcharges: [], purchased: new Set(), purchased_prices: {} });
const option = sheet.plans["Mechanical Protection"][0].options[0];
const K = option.key;
const at = (cents) => checkPreparation(sheet, { cells: {}, prices: { [K]: cents }, surcharges: [] });
const onScreen = (cents) => ({ ...model.initialState(sheet), prices: { [K]: cents } });

test("the cell dialog says the range, the manager rule and dealer cost, plainly", () => {
  assert.deepEqual(option.band, { floor: 39600, top: 92000 });
  assert.equal(model.rangeText(option),
    "Staff may price from $396.00 to $920.00, before surcharges. Outside that range needs a manager. No price may go below dealer cost ($321.00).");
  assert.doesNotMatch(model.rangeText(option), /—/);
});

test("a staff price inside the range is accepted, no manager", () => {
  for (const cents of [39600, 50000, 92000]) {
    const c = at(cents);
    assert.deepEqual([c.errors, c.above_band, c.below_band], [[], [], []], String(cents));
    assert.deepEqual(model.needsManager(sheet, onScreen(cents)), []);
  }
});

test("a staff price below the floor asks for a manager", () => {
  const c = at(35000);
  assert.deepEqual([c.errors, c.below_band, c.above_band], [[], [K], []]);
  assert.deepEqual(model.needsManager(sheet, onScreen(35000)), [K]);
  const f = model.cellFigures(option, onScreen(35000));
  assert.deepEqual([f.below_band, f.below_cost], [true, false]);
});

test("a manager below the floor is accepted with a reason, and it is recorded on the price", () => {
  const c = at(35000);
  assert.deepEqual(c.writes, [{ key: K, retail_cents: 35000, above_band: false, below_band: true }]);
  const fn = read("supabase/functions/fni-menu-prepare/index.ts");
  // The manager and reason go on the price, and a session event says so.
  assert.match(fn, /below_band: w\.below_band,\s*approved_by: w\.above_band \|\| w\.below_band \? managerName : null,\s*reason: w\.above_band \|\| w\.below_band \? reason : null,/);
  assert.match(fn, /export const BELOW_BAND_EVENT = "Price below the band allowed by a manager on Prepare menu";/);
  // Without a manager and a reason, refused.
  assert.match(fn, /if \(outside > 0 && \(!\(await isManager\(supabase, body\.manager_id\)\) \|\| reason === "" \|\| managerName === ""\)\)/);
  // And Prepare menu shows it from the saved price.
  const saved = buildSheet({ families: FAMILIES, catalog: CATALOG, rules: RULES, columns: [{ name: "Gold", preset_categories: ["Mechanical Protection"], starting_level: "Highest" }],
    presets: [], prepared: null, prices: { [K]: { retail_price: 350, above_band: false, below_band: true, approved_by: "Sample Manager", reason: "Sample reason" } },
    surcharges: [], purchased: new Set(), purchased_prices: {} });
  const o = saved.plans["Mechanical Protection"][0].options[0];
  assert.deepEqual([o.price, o.below_band, o.approved_by], [35000, true, "Sample Manager"]);
  assert.match(read("supabase/functions/_shared/menu-prepare-rows.ts"), /select\("option_key, retail_price, above_band, below_band, approved_by, reason"\)/);
});

test("any price below dealer cost is refused, a manager included", () => {
  const c = at(32099);
  assert.deepEqual(c.errors, ["Sample Care, 2 years / Unlimited miles, No deductible: No price may go below dealer cost."]);
  assert.deepEqual(c.writes, []);
  // Not a manager's to allow: the screen does not ask for one, and says it will not save.
  assert.deepEqual(model.needsManager(sheet, onScreen(32099)), []);
  assert.equal(model.cellFigures(option, onScreen(32099)).below_cost, true);
  // On the server the errors are answered before any manager is considered.
  const fn = read("supabase/functions/fni-menu-prepare/index.ts");
  assert.ok(fn.indexOf("if (check.errors.length > 0) return json(400") < fn.indexOf("const outside = check.above_band.length"));
});

test("a staff price above the ceiling asks for a manager", () => {
  const c = at(92001);
  assert.deepEqual([c.errors, c.above_band, c.below_band], [[], [K], []]);
  assert.deepEqual(model.needsManager(sheet, onScreen(92001)), [K]);
});
