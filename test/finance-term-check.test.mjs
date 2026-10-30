// test/finance-term-check.test.mjs
//
// The chosen finance term against the CRM (_shared/finance-term-check.ts,
// fni-dx1-check). Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TERMS_NOT_CHECKED,
  chosenTermToCheck,
  compareFinanceTerm,
  withFinanceTerm,
} from "../supabase/functions/_shared/finance-term-check.ts";
import { FAILED, NOTHING } from "../supabase/functions/_shared/dx1-check.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const financed = (term) => ({
  finance_type: "Finance",
  lienholder_name: "Sample Credit Union",
  menu_choice: term === undefined ? null : { column: 2, name: "Gold", term, kept: [], removed: [] },
});
const EXTRA = { months: 72, rate: 7.74, deal_term: false };
const crm = (Term_Months, Interest_Rate) => ({ id: "1234567890123", Term_Months, Interest_Rate });
const MATCH = { status: "Match", blocking: [], warnings: [] };

const linesFor = (term, record) => compareFinanceTerm(chosenTermToCheck(financed(term)), record);

test("the chosen term matches the CRM: nothing said", () => {
  assert.deepEqual(linesFor(EXTRA, crm(72, 7.74)), { blocking: [], warnings: [] });
});

test("the term differs: one blocking line, worded exactly", () => {
  assert.deepEqual(linesFor(EXTRA, crm(60, 7.74)).blocking, [
    "Finance terms: the customer chose 72 months at 7.74%, but the CRM shows 60 months at 7.74%. " +
      "Update the deal in DX1, press Update on this DocuRide record, then generate again.",
  ]);
});

test("the rate differs: one blocking line", () => {
  const r = linesFor(EXTRA, crm(72, 5.9));
  assert.equal(r.blocking.length, 1);
  assert.match(r.blocking[0], /chose 72 months at 7\.74%, but the CRM shows 72 months at 5\.90%\./);
});

test("both differ: still one line, naming both", () => {
  const r = linesFor(EXTRA, crm(60, 5.9));
  assert.deepEqual(r.blocking, [
    "Finance terms: the customer chose 72 months at 7.74%, but the CRM shows 60 months at 5.90%. " +
      "Update the deal in DX1, press Update on this DocuRide record, then generate again.",
  ]);
  assert.deepEqual(r.warnings, []);
});

test("rates equal at two decimal places match, however written", () => {
  const seven = { months: 72, rate: 7.7, deal_term: false };
  assert.deepEqual(linesFor(seven, crm(72, "7.70")), { blocking: [], warnings: [] });
  assert.deepEqual(linesFor({ ...seven, rate: 7.70 }, crm(72, 7.7)), { blocking: [], warnings: [] });
  assert.deepEqual(linesFor(seven, crm(72, "7.7%")), { blocking: [], warnings: [] });
  assert.deepEqual(linesFor(EXTRA, crm("72", 7.7400000001)), { blocking: [], warnings: [] });
  // A real difference in the second decimal is still a difference.
  assert.equal(linesFor(EXTRA, crm(72, 7.75)).blocking.length, 1);
});

test("no chosen package, or a package on the deal's own term: nothing to compare", () => {
  assert.equal(chosenTermToCheck(financed(undefined)), null);
  assert.equal(chosenTermToCheck(financed(null)), null);
  assert.equal(chosenTermToCheck(financed({ months: 60, rate: 5.9, deal_term: true })), null);
  assert.deepEqual(compareFinanceTerm(null, crm(60, 5.9)), { blocking: [], warnings: [] });
  assert.deepEqual(compareFinanceTerm(null, null), { blocking: [], warnings: [] });
});

test("a cash deal: nothing to compare", () => {
  assert.equal(chosenTermToCheck({ ...financed(EXTRA), finance_type: "Cash" }), null);
  assert.equal(chosenTermToCheck({ ...financed(EXTRA), finance_type: null, lienholder_name: null }), null);
  assert.deepEqual(chosenTermToCheck(financed(EXTRA)), { months: 72, rate: 7.74 });
});

test("a CRM read failure, or a term or rate it cannot read: a warning, never a block", () => {
  for (const record of [null, crm(null, 7.74), crm(72, null), crm("", ""), crm("seventy", 7.74), crm(72.5, 7.74)]) {
    assert.deepEqual(linesFor(EXTRA, record), { blocking: [], warnings: [TERMS_NOT_CHECKED] });
  }
  assert.equal(TERMS_NOT_CHECKED, "Finance terms could not be checked against the CRM.");
});

test("the status: a term block is Problems; a warning alone never blocks", () => {
  const block = linesFor(EXTRA, crm(60, 5.9));
  const warn = { blocking: [], warnings: [TERMS_NOT_CHECKED] };
  // No live contracts.
  assert.deepEqual(withFinanceTerm(NOTHING, block), { status: "Problems", blocking: block.blocking, warnings: [] });
  assert.deepEqual(withFinanceTerm(NOTHING, warn), { status: "Nothing to check", blocking: [], warnings: [TERMS_NOT_CHECKED] });
  assert.equal(withFinanceTerm(NOTHING, { blocking: [], warnings: [] }), NOTHING);
  // Products matched.
  assert.equal(withFinanceTerm(MATCH, { blocking: [], warnings: [] }), MATCH);
  assert.equal(withFinanceTerm(MATCH, block).status, "Problems");
  // The CRM could not be read at all: both say so, nothing blocks.
  assert.deepEqual(withFinanceTerm(FAILED, warn), {
    status: "Nothing to check", blocking: [], warnings: ["F&I contracts could not be checked against DX1", TERMS_NOT_CHECKED],
  });
  // Product lines come first, the term's after.
  const products = { status: "Problems", blocking: ["A product line."], warnings: ["A wording line."] };
  assert.deepEqual(withFinanceTerm(products, block).blocking, ["A product line.", block.blocking[0]]);
});

test("fni-dx1-check reads the choice, keeps the shape, and never keeps a failed read", () => {
  const src = read("supabase/functions/fni-dx1-check/index.ts");
  assert.match(src, /select\("id, zoho_deal_id, dx1_check, finance_type, lienholder_name, menu_choice"\)/);
  assert.match(src, /if \(live\.length === 0 && !chosen\)/);
  const failed = src.slice(src.indexOf("if (!record) {"), src.indexOf("const products ="));
  assert.match(failed, /return withFinanceTerm\(live\.length === 0 \? NOTHING : FAILED, compareFinanceTerm\(chosen, null\)\);/);
  assert.doesNotMatch(failed, /keep\(/);
  assert.match(src, /reply\(200, \{ status: result\.status, blocking: result\.blocking, warnings: result\.warnings \}\)/);
  assert.match(src, /const BUDGET_MS = 4500;/);
  // Logs carry counts and statuses, never a rate or term.
  for (const m of src.matchAll(/console\.(?:log|error|warn)\(([^;]*)\);/gs)) {
    assert.doesNotMatch(m[1], /rate|months|chosen\.|record\./i);
  }
});

test("Details: the products' fix line only when a product line is there", async () => {
  const view = read("apps/ownership-planner/components/Dx1Check.tsx");
  const TERM_LINE = new RegExp(view.match(/const TERM_LINE = \/(.+)\/;/)[1]);
  const block = compareFinanceTerm({ months: 72, rate: 7.74 }, crm(60, 5.9)).blocking[0];
  assert.ok(TERM_LINE.test(block));
  assert.ok(TERM_LINE.test(TERMS_NOT_CHECKED));
  for (const product of [
    "Tire and Wheel (contract SAMPLE-1): DX1 shows $585.00, but the contract price is $595.00.",
    "DX1 has a product in Aftermarket 2 for $199.00 that does not match any contract on this deal.",
    "F&I contracts could not be checked against DX1",
  ]) assert.ok(!TERM_LINE.test(product));
});
