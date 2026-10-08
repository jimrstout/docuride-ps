// The admin area's Pricing section.
//
// Rules are edited at /admin/pricing and saved through fni-admin-settings. The
// preview and the gap check use the planner's own priceProduct and resolveRule,
// so what staff see is what a customer is shown. Nothing here changes the
// formula; the last tests hold it to Parkersburg's live prices.
//
// (test/admin-pricing.test.mjs is the older static admin site's, not this.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ANY_PRODUCT,
  SAMPLE_COSTS,
  bandsOverlap,
  copyRefusal,
  gapSentence,
  parseRuleFields,
  previewPrices,
  pricingGaps,
  ruleSummary,
  rulesInForce,
  storeStatus,
  validateRule,
} from "../supabase/functions/_shared/pricing-admin.ts";
import { priceProduct, resolveRule } from "../supabase/functions/_shared/planner-pricing.ts";
import { ADMIN_SECTIONS } from "../apps/ownership-planner/lib/admin-sections.ts";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const page = read("apps/ownership-planner/app/admin/pricing/page.tsx");
const handler = read("supabase/functions/fni-admin-settings/pricing.ts");
const index = read("supabase/functions/fni-admin-settings/index.ts");
const actions = read("apps/ownership-planner/app/console-actions.ts");
const shared = read("supabase/functions/_shared/pricing-admin.ts");

const T = "tenant-1";
const PKB = "store-pkb";
const HTN = "store-htn";
const ACTIVE = new Set([PKB, HTN]);

let n = 0;
const rule = (over = {}) => ({
  id: `r${++n}`,
  tenant_id: T,
  store_id: PKB,
  product_code: null,
  cost_floor: 0,
  cost_ceiling: 400,
  markup_percent: 250,
  markup_max_dollars: 600,
  markup_min_dollars: 75,
  round_to: 5,
  active: true,
  ...over,
});

/** Parkersburg's three live rules. */
const parkersburg = () => [
  rule({ id: "p1", cost_floor: 0, cost_ceiling: 400, markup_percent: 250, markup_min_dollars: 75, markup_max_dollars: 600 }),
  rule({ id: "p2", cost_floor: 400, cost_ceiling: 900, markup_percent: 120, markup_min_dollars: 0, markup_max_dollars: 800 }),
  rule({ id: "p3", cost_floor: 900, cost_ceiling: 5000, markup_percent: 65, markup_min_dollars: 0, markup_max_dollars: 900 }),
];

const fields = (over = {}) => {
  const r = parseRuleFields({
    product_code: "",
    cost_floor: "0",
    cost_ceiling: "400",
    markup_percent: "250",
    markup_min_dollars: "75",
    markup_max_dollars: "600",
    round_to: "5",
    active: "on",
    ...over,
  });
  return r;
};

// ── The menu ────────────────────────────────────────────────────────────

test("Pricing is listed between Sessions and Wording", () => {
  assert.deepEqual(ADMIN_SECTIONS.map((s) => s.label), ["Sessions", "Pricing", "Wording"]);
  assert.equal(ADMIN_SECTIONS[1].href, "/admin/pricing");
});

test("the page checks the operator before it fetches, like every admin page", () => {
  const check = page.indexOf("if (!operator) return null;");
  assert.ok(check > page.lastIndexOf("export default"));
  assert.ok(page.indexOf("edge.adminPricing") > 0);
});

// ── Stores ─────────────────────────────────────────────────────────────

test("stores come from active provider accounts, and none are named in code", () => {
  // Since 0021, any active account with an active provider, not only TecAssured.
  assert.match(handler, /\.from\("store_provider_accounts"\)[\s\S]*?providers!inner\(active\)[\s\S]*?\.eq\("active", true\)[\s\S]*?\.eq\("provider\.active", true\)/);
  assert.doesNotMatch(handler, /\.eq\("provider", "TecAssured"\)/);
  for (const name of ["Parkersburg", "Charleston", "Huntington", "New Martinsville"]) {
    for (const [file, src] of [["page", page], ["handler", handler], ["shared", shared]]) {
      assert.doesNotMatch(src, new RegExp(name), `${name} in ${file}`);
    }
  }
  assert.match(page, /`The menu runs at: \$\{payload\.stores\.map\(\(s\) => s\.name\)\.join\(", "\)\}\.`/);
});

test("the picker leads with All stores, and each store has one of three statuses", () => {
  assert.match(page, /<span>All stores \(default\)<\/span>/);
  assert.ok(page.indexOf("All stores (default)") < page.indexOf("payload.stores.map((s) => ("));

  const own = parkersburg();
  assert.equal(storeStatus(own, PKB), "Own rules");
  assert.equal(storeStatus(own, HTN), "No pricing: products will not be shown");
  const withDefault = [...own, rule({ store_id: null })];
  assert.equal(storeStatus(withDefault, HTN), "Uses All stores");
  // A turned-off rule does not count.
  assert.equal(storeStatus([rule({ store_id: HTN, active: false })], HTN), "No pricing: products will not be shown");
});

test("the note about changes applying right away is at the top", () => {
  const at = page.indexOf("Changes apply right away, including to deals being presented now.");
  assert.ok(at > 0);
  assert.ok(at < page.indexOf("The menu runs at"));
  assert.ok(at < page.indexOf("<nav className=\"ad-seg\""));
});

// ── The table ───────────────────────────────────────────────────────────

test("the rules table has the columns asked for", () => {
  for (const c of [
    "Applies to", "Dealer cost from", "Dealer cost to", "Markup percent",
    "Minimum markup ($)", "Maximum markup ($)", "Round to ($)", "Active",
  ]) {
    assert.ok(page.includes(`"${c}"`), c);
  }
  assert.match(page, /<option value="">All products<\/option>/);
  assert.match(page, /placeholder="No maximum"/);
  // Add, edit and delete.
  assert.match(page, /\{rule \? "Save" : "Add rule"\}/);
  assert.match(page, /formAction=\{deletePricingRule\}/);
});

test("each rule is summarised in plain English", () => {
  assert.equal(
    ruleSummary(parkersburg()[0]),
    "Products costing $0 to $400: 250% markup, at least $75, no more than $600, rounded to $5."
  );
  assert.equal(
    ruleSummary(rule({ product_code: "GAP", markup_min_dollars: 0, markup_max_dollars: null, cost_floor: 400, cost_ceiling: 5000, markup_percent: 12.5, round_to: 0 }), "Guaranteed Asset Protection"),
    "Guaranteed Asset Protection costing $400 to $5,000: 12.5% markup, no maximum, not rounded."
  );
  assert.match(ruleSummary(rule({ active: false })), /^Turned off\. Products costing/);
  assert.match(page, /\{rule\.summary\}/);
});

test("each rule says who last changed it", () => {
  assert.match(page, /`Last changed by \$\{rule\.updated_by\} on \$\{on\}\.`/);
  assert.match(page, /Who changed it was not recorded\./);
});

// ── Validation ──────────────────────────────────────────────────────────

test("a rule reads from typed text, blank min is 0 and blank max is no maximum", () => {
  const r = fields({ markup_min_dollars: "", markup_max_dollars: "", cost_ceiling: "$1,200.50" });
  assert.deepEqual(r.fields, {
    product_code: null, cost_floor: 0, cost_ceiling: 1200.5, markup_percent: 250,
    markup_min_dollars: 0, markup_max_dollars: null, round_to: 5, active: true,
  });
  assert.equal(fields({ active: undefined }).fields.active, false);
  assert.equal(fields({ product_code: "GAP" }).fields.product_code, "GAP");
});

test("from must be less than to", () => {
  assert.deepEqual(fields({ cost_floor: "400", cost_ceiling: "400" }).errors,
    ["Dealer cost from must be less than Dealer cost to."]);
  assert.deepEqual(fields({ cost_floor: "500", cost_ceiling: "400" }).errors,
    ["Dealer cost from must be less than Dealer cost to."]);
});

test("percent, min, max and round-to cannot be negative", () => {
  for (const [key, label] of [
    ["markup_percent", "Markup percent"], ["markup_min_dollars", "Minimum markup"],
    ["markup_max_dollars", "Maximum markup"], ["round_to", "Round to"], ["cost_floor", "Dealer cost from"],
  ]) {
    assert.ok(fields({ [key]: "-1" }).errors.includes(`${label} cannot be negative.`), key);
  }
  assert.ok(fields({ markup_percent: "lots" }).errors.includes("Markup percent must be a number."));
  assert.ok(fields({ markup_percent: "" }).errors.includes("Markup percent is required."));
  assert.ok(fields({ cost_ceiling: "10.001" }).errors.includes("Dealer cost to can have at most two decimal places."));
});

test("min cannot be more than max when both are set", () => {
  assert.deepEqual(fields({ markup_min_dollars: "700", markup_max_dollars: "600" }).errors,
    ["Minimum markup cannot be more than the maximum markup."]);
  assert.ok("fields" in fields({ markup_min_dollars: "700", markup_max_dollars: "" }));
  assert.ok("fields" in fields({ markup_min_dollars: "600", markup_max_dollars: "600" }));
});

test("active rules for the same store and product cannot overlap, but may touch", () => {
  const saved = parkersburg();
  const check = (over, storeId = PKB, editing = null) =>
    validateRule(fields(over).fields, storeId, saved, editing, ACTIVE);

  assert.equal(bandsOverlap({ cost_floor: 0, cost_ceiling: 400 }, { cost_floor: 400, cost_ceiling: 900 }), false);
  assert.equal(bandsOverlap({ cost_floor: 0, cost_ceiling: 401 }, { cost_floor: 400, cost_ceiling: 900 }), true);

  const [why] = check({ cost_floor: "300", cost_ceiling: "500" });
  assert.match(why, /^This overlaps the active rule for all products from \$0 to \$400\./);
  // Touching is fine.
  assert.deepEqual(check({ cost_floor: "5000", cost_ceiling: "10000" }), []);
  // Another store, a product of its own, or a turned-off rule do not clash.
  assert.deepEqual(check({ cost_floor: "300", cost_ceiling: "500" }, HTN), []);
  assert.deepEqual(check({ cost_floor: "300", cost_ceiling: "500", product_code: "GAP" }), []);
  assert.deepEqual(check({ cost_floor: "300", cost_ceiling: "500", active: undefined }), []);
  assert.deepEqual(
    validateRule(fields({ cost_floor: "300", cost_ceiling: "500" }).fields, PKB,
      saved.map((r) => ({ ...r, active: r.id !== "p1" ? r.active : false })), null, ACTIVE)
      .filter((e) => /\$0 to \$400/.test(e)),
    []
  );
  // A rule does not overlap itself when it is edited.
  assert.deepEqual(check({ cost_floor: "0", cost_ceiling: "350" }, PKB, "p1"), []);
});

test("store rules only for stores with an active provider account", () => {
  const [why] = validateRule(fields().fields, "store-closed", [], null, ACTIVE);
  assert.equal(why, "That store has no active provider account, so it cannot have its own pricing.");
  assert.deepEqual(validateRule(fields().fields, null, [], null, ACTIVE), []);
});

test("the server checks every write, and the browser writes nothing", () => {
  assert.match(handler, /const parsed = parseRuleFields\(/);
  assert.match(handler, /validateRule\(fields, storeId, rules, ruleId, activeStoreIds/);
  assert.match(handler, /copyRefusal\(storeId, to\.storeId, rules, activeStoreIds\)/);
  assert.match(handler, /That product is not in the catalog here\./);
  // Refusals come back as plain sentences.
  assert.match(handler, /return \{ status: 400, body: \{ error: errors\.join\(" "\), errors \} \};/);
  // Routed through the same function and the same secret as Wording.
  assert.match(index, /if \(!authorized\(req, url\)\) return json\(401/);
  assert.match(index, /if \(body\.section === "pricing"\) \{\s*const reply = await writePricing\(supabase, tenant\.id, body\);/);
  assert.match(index, /searchParams\.get\("section"\) === "pricing"/);
  // The page is a server component with no fetch of its own.
  assert.doesNotMatch(page, /"use client"/);
  assert.doesNotMatch(page, /fetch\(/);
  assert.doesNotMatch(page, /supabase/i);
  // Each action checks the operator and sends their email as updated_by.
  assert.match(actions, /const operator = await currentOperator\(\);\s*if \(!operator\) redirect\(PRICING\);/);
  assert.match(actions, /edge\.adminSavePricing\(\{ \.\.\.body, scope, updated_by: operator\.email \}\)/);
});

test("every save, edit and copy records who made it", () => {
  assert.match(handler, /const row = \{ \.\.\.fields, updated_at: now, updated_by: updatedBy \};/);
  assert.match(handler, /updated_at: now,\s*updated_by: updatedBy,\s*\}\)\);/);
  assert.match(handler, /A change to pricing needs the name of whoever is signed in\./);
  const sql = read("supabase/migrations/0020_pricing_rules_updated_by.sql");
  assert.match(sql, /alter table fni\.pricing_rules add column if not exists updated_by text;/);
});

// ── Copy ────────────────────────────────────────────────────────────────

test("copying refuses a target that already has rules", () => {
  const rules = parkersburg();
  assert.equal(copyRefusal(PKB, HTN, rules, ACTIVE), null);
  assert.equal(copyRefusal(PKB, null, rules, ACTIVE), null);
  assert.match(copyRefusal(PKB, HTN, [...rules, rule({ store_id: HTN, active: false })], ACTIVE),
    /^That already has rules\./);
  assert.equal(copyRefusal(HTN, PKB, rules, ACTIVE), "There are no rules here to copy.");
  assert.equal(copyRefusal(PKB, PKB, rules, ACTIVE), "Choose a different place to copy these rules to.");
  assert.match(copyRefusal(PKB, "store-closed", rules, ACTIVE), /no active provider account/);
  assert.match(page, /<span>Copy these rules to\.\.\.<\/span>/);
});

// ── Preview ────────────────────────────────────────────────────────────

test("the preview prices with the planner's own functions, and names the rule", () => {
  const rules = parkersburg();
  const rows = previewPrices(rules, PKB, SAMPLE_COSTS, null);
  assert.deepEqual(SAMPLE_COSTS, [100, 300, 600, 1200, 2500]);
  assert.deepEqual(rows.map((r) => r.price), [350, 900, 1320, 1980, 3400]);
  assert.deepEqual(rows.map((r) => r.rule_id), ["p1", "p1", "p2", "p3", "p3"]);
  for (const r of rows) {
    // Exactly what the planner would show, from the same call.
    const planner = priceProduct(rulesInForce(rules, PKB), ANY_PRODUCT, r.cost);
    assert.equal(r.price, planner.retail_price);
    assert.equal(r.rule_id, planner.rule_id);
    assert.equal(r.rule_from, "This store");
    assert.equal(r.rule_summary, ruleSummary(resolveRule(rules, ANY_PRODUCT, r.cost)));
  }
});

test("the preview falls back to All stores, as the planner does", () => {
  const rules = [
    ...parkersburg(),
    rule({ id: "t1", store_id: null, cost_floor: 0, cost_ceiling: 10000, markup_percent: 50, markup_min_dollars: 0, markup_max_dollars: null }),
    // Another store's rule never applies here.
    rule({ id: "h1", store_id: HTN, cost_floor: 5000, cost_ceiling: 10000, markup_percent: 1 }),
  ];
  const [pkb] = previewPrices(rules, PKB, [6000], null);
  assert.equal(pkb.rule_id, "t1");
  assert.equal(pkb.rule_from, "All stores");
  assert.equal(pkb.price, 9000);

  // A store with no rules of its own uses All stores for everything.
  const charleston = previewPrices(rules, "store-chs", [100], null)[0];
  assert.deepEqual([charleston.rule_id, charleston.price], ["t1", 150]);

  // A cost nothing covers is not shown.
  const none = previewPrices(parkersburg(), PKB, [7500], null)[0];
  assert.equal(none.price, null);
  assert.equal(none.reason, "No rule covers this cost, so the product would not be shown.");

  // A product rule beats All products in the preview, just as in the planner.
  const gap = [...parkersburg(), rule({ id: "g1", product_code: "GAP", cost_floor: 0, cost_ceiling: 5000, markup_percent: 10, markup_min_dollars: 0, markup_max_dollars: null })];
  assert.equal(previewPrices(gap, PKB, [100], "GAP")[0].rule_id, "g1");
  assert.equal(previewPrices(gap, PKB, [100], null)[0].rule_id, "p1");
});

test("the preview shows the sample costs plus one staff can type", () => {
  assert.match(page, /<input name="cost" inputMode="decimal"/);
  assert.match(handler, /typed: typedCost === null \? null : previewPrices\(rules, storeId, \[typedCost\]/);
  assert.match(handler, /previewPrices\(rules, storeId, SAMPLE_COSTS, previewProduct, nameOf\)/);
});

// ── Gaps ───────────────────────────────────────────────────────────────

test("the gap check covers $0 to $10,000 and accounts for the fallback", () => {
  assert.deepEqual(pricingGaps(parkersburg(), PKB), [{ from: 5000, to: 10000 }]);
  assert.equal(
    gapSentence({ from: 5000, to: 10000 }),
    "Costs from $5,000 to $10,000 have no rule. Those products will not be shown."
  );

  // A store with nothing, and no All stores rules, has no price anywhere.
  assert.deepEqual(pricingGaps(parkersburg(), HTN), [{ from: 0, to: 10000 }]);

  // All stores fills the store's gap, so there is none.
  const withDefault = [...parkersburg(), rule({ store_id: null, cost_floor: 4000, cost_ceiling: 20000 })];
  assert.deepEqual(pricingGaps(withDefault, PKB), []);
  // And it is what a store with no rules of its own gets.
  assert.deepEqual(pricingGaps(withDefault, HTN), [{ from: 0, to: 4000 }]);
  // All stores on its own ignores every store's rules.
  assert.deepEqual(pricingGaps(withDefault, null), [{ from: 0, to: 4000 }]);

  // A gap between bands, a turned-off rule, and a product-only rule.
  const holes = [
    rule({ cost_floor: 0, cost_ceiling: 400 }),
    rule({ cost_floor: 450.5, cost_ceiling: 10000 }),
    rule({ cost_floor: 400, cost_ceiling: 450.5, active: false }),
    rule({ cost_floor: 400, cost_ceiling: 450.5, product_code: "GAP" }),
  ];
  assert.deepEqual(pricingGaps(holes, PKB), [{ from: 400, to: 450.5 }]);
  assert.equal(gapSentence({ from: 400, to: 450.5 }),
    "Costs from $400 to $450.50 have no rule. Those products will not be shown.");
});

// ── Untouched ─────────────────────────────────────────────────────────

test("the formula is unchanged: Parkersburg's live prices", () => {
  const rules = parkersburg();
  const price = (c) => priceProduct(rules, "16_3", c).retail_price;
  assert.equal(price(100), 350);   // 250% is $250, between $75 and $600
  assert.equal(price(20), 95);     // 250% is $50, raised to the $75 minimum
  assert.equal(price(300), 900);   // 250% is $750, held to $600
  assert.equal(price(399.99), 1000); // $999.99 rounded to $5
  assert.equal(price(400), 880);   // the next band begins at 400
  assert.equal(price(1200), 1980); // 65% is $780
  assert.equal(priceProduct(rules, "16_3", 5000).unpriced_reason !== null, true);
});

test("Pricing copy is plain English with no em dashes", () => {
  for (const [file, src] of [["page", page], ["handler", handler], ["shared", shared]]) {
    assert.doesNotMatch(src, /—/, `${file} has an em dash`);
  }
  assert.doesNotMatch(page, /DX1/);
});
