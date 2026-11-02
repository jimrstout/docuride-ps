// The coverage term a menu cell starts at, when no preset sets one.
//
// Mechanical Protection offered at 12, 24, 36 and 48 months used to start at
// 12: with no preset term, every term was equally close and the tie went to
// the shorter. Now it starts at the longest offered term that does not run
// past the finance term, the longest offered on a cash deal. A menu row can
// set a preferred term in Administration > Menus (migration 0049); a preset's
// own term still comes first; staff can still change it on Prepare
// presentation. Whatever term is chosen, that option's own price is the one
// that goes on the selection. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSheet, optionFor } from "../supabase/functions/_shared/menu-prepare.ts";
import { defaultTermMonths, optionKey } from "../supabase/functions/_shared/menu-presets.ts";
import { parseSlot } from "../supabase/functions/_shared/menu-admin.ts";
import { customerPriceFor, priceFamilies } from "../supabase/functions/_shared/plan-prices.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const P = "prov-1";
const rate = (id, months, cost) => ({
  rate_unique_id: id, term_months: months, term_miles: 0, deductible: 0, deductible_code: null, disappearing_deductible: false,
  dealer_cost: cost, provider_markup: 0, offered_price: null, options: [], raw: {},
});
// Mechanical Protection at 12, 24, 36 and 48 months, each its own cost.
const families = () => [
  { family_code: "VSA", provider_id: P, provider_name: "Sample", tiers: [
    { product_code: "MP-1", product_name: "SAMPLE CARE", product_type: "VSA", provider_id: P, raw: {},
      rates: [rate("m12", 12, 211.11), rate("m24", 24, 322.22), rate("m36", 36, 433.33), rate("m48", 48, 544.44)] },
  ] },
];
const CATALOG = [{ provider_id: P, product_code: "MP-1", display_name: "Sample Mechanical Protection", category: "Mechanical Protection", display_order: 110 }];
const RULES = [{ id: "r", tenant_id: "t", store_id: null, provider_id: null, product_code: null, cost_floor: 0, cost_ceiling: 9999,
  markup_percent: 37, markup_min_dollars: 0, markup_max_dollars: null, round_to: 0, active: true, max_markup_percent: 80, max_markup_dollars: null }];
const COLUMNS = [{ name: "Best", preset_categories: ["Mechanical Protection"], starting_level: "Highest" }];

function sheetFor({ basis, preferred, presets = [], prepared = null }) {
  return buildSheet({
    families: priceFamilies(families(), RULES), catalog: CATALOG, rules: RULES, columns: COLUMNS, presets, prepared,
    prices: {}, surcharges: [], purchased: new Set(), purchased_prices: {},
    term_basis: basis, preferred_terms: preferred ? { "Mechanical Protection": preferred } : {},
  });
}
const chosen = (sheet) => optionFor(sheet, sheet.cells["1"]["Mechanical Protection"].key).option;
const LOAN = (months) => ({ financed: true, months });
const CASH = { financed: false, months: null };

test("the default is the longest offered term within the finance term", () => {
  assert.equal(chosen(sheetFor({ basis: LOAN(60) })).term_months, 48);
  assert.equal(chosen(sheetFor({ basis: LOAN(24) })).term_months, 24);
  assert.equal(chosen(sheetFor({ basis: LOAN(30) })).term_months, 24);
  assert.equal(chosen(sheetFor({ basis: CASH })).term_months, 48);
  // The rule alone.
  assert.equal(defaultTermMonths([12, 24, 36, 48], LOAN(60)), 48);
  assert.equal(defaultTermMonths([12, 24, 36, 48], LOAN(24)), 24);
  assert.equal(defaultTermMonths([12, 24, 36, 48], CASH), 48);
  // A finance term that cannot be read: the longest, as on cash.
  assert.equal(defaultTermMonths([12, 24, 36, 48], LOAN(null)), 48);
  // Every offered term runs past the loan: the shortest, the least past it.
  assert.equal(defaultTermMonths([36, 48], LOAN(12)), 36);
  assert.equal(defaultTermMonths([], LOAN(60)), null);
});

test("the term shows in plain English", () => {
  assert.equal(chosen(sheetFor({ basis: LOAN(60) })).label, "4 years / Unlimited miles, No deductible");
  assert.equal(chosen(sheetFor({ basis: LOAN(36) })).label, "3 years / Unlimited miles, No deductible");
});

test("a menu row's preferred term wins over the default", () => {
  assert.equal(chosen(sheetFor({ basis: LOAN(60), preferred: 24 })).term_months, 24);
  assert.equal(chosen(sheetFor({ basis: CASH, preferred: 36 })).term_months, 36);
  // Not offered exactly: the closest, a tie going to the shorter.
  assert.equal(chosen(sheetFor({ basis: LOAN(60), preferred: 30 })).term_months, 24);
  // A preset's own term still comes first.
  const preset = { column_position: 1, category: "Mechanical Protection", provider_id: null, plan_name: null, term_months: 12, term_miles: null, deductible: null, disappearing_deductible: null };
  assert.equal(chosen(sheetFor({ basis: LOAN(60), preferred: 36, presets: [preset] })).term_months, 12);
});

test("a staff change on Prepare presentation wins", () => {
  const k12 = optionKey(P, "MP-1", rate("m12", 12, 211.11));
  const sheet = sheetFor({ basis: LOAN(60), preferred: 36, prepared: { "1": { "Mechanical Protection": k12 } } });
  assert.equal(chosen(sheet).term_months, 12);
});

test("the price on the selection is the chosen term's own, to the cent", () => {
  for (const [basis, id] of [[LOAN(60), "m48"], [LOAN(24), "m24"], [CASH, "m48"], [LOAN(36), "m36"]]) {
    const option = chosen(sheetFor({ basis }));
    assert.equal(option.rate_unique_id, id);
    // What the save prices on the server for that rate (fni-session-save).
    const saved = customerPriceFor(priceFamilies(families(), RULES), "MP-1", id, [], P);
    assert.equal(Math.round(saved * 100), option.price, id);
  }
  // Each term its own price: 48 months is not the 12-month price.
  const p12 = customerPriceFor(priceFamilies(families(), RULES), "MP-1", "m12", [], P);
  const p48 = customerPriceFor(priceFamilies(families(), RULES), "MP-1", "m48", [], P);
  assert.notEqual(p12, p48);
  // The one-cent Submit guard is untouched.
  assert.match(read("supabase/functions/fni-contract-submit/index.ts"), /priceProblems\(/);
});

test("Administration > Menus sets a row's preferred term", () => {
  const P1 = "11111111-1111-4111-8111-111111111111";
  assert.equal(parseSlot({ title: "Mechanical Protection", product_ids: [P1], preferred_term_months: "36" }, [P1]).fields.preferred_term_months, 36);
  assert.equal(parseSlot({ title: "Mechanical Protection", product_ids: [P1], preferred_term_months: "" }, [P1]).fields.preferred_term_months, null);
  assert.deepEqual(parseSlot({ title: "Mechanical Protection", product_ids: [P1], preferred_term_months: "four" }, [P1]).errors, [
    "The preferred term is not a number of months.",
  ]);
  const page = read("apps/ownership-planner/app/admin/menus/page.tsx");
  assert.match(page, /<select name="preferred_term_months"/);
  assert.match(page, /Longest within the finance term \(longest on cash\)/);
  assert.match(read("apps/ownership-planner/app/console-actions.ts"), /preferred_term_months: field\(fd, "preferred_term_months"\),/);
  // Prepare and Present menu both read it, with the deal's finance term.
  const rows = read("supabase/functions/_shared/menu-prepare-rows.ts");
  assert.match(rows, /term_basis: \{ financed, months: financed \? sessionPaymentBasis\(s\)\.termMonths : null \},/);
  assert.match(rows, /preferred_terms: preferredTerms,/);
});
