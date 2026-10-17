// The last planner screen lists every plan shown and the decision on each.
//
// "What you were shown, and what you decided" promised every plan, the decision
// on each, and the resulting payment, and showed only the down payment. Found on
// a real session (5f8be61f, deal 14957): eleven plans across five screens, two
// chosen. This holds that session's shape and renders the real component.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { decisionRecord } from "../apps/ownership-planner/lib/decision-record.ts";
import { planTotals, toCents, money } from "../apps/ownership-planner/lib/money.ts";
import { render } from "./_jsx-string.mjs";

const here = (rel) => new URL(rel, import.meta.url);
const src = (rel) => readFileSync(here(rel), "utf8");

/** The component, transpiled by TypeScript and rendered through the string runtime. */
async function loadDecisionRecord() {
  const out = ts.transpileModule(src("../apps/ownership-planner/components/DecisionRecord.tsx"), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "JSXSHIM",
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
    .replace('"JSXSHIM/jsx-runtime"', JSON.stringify(here("./_jsx-string.mjs").href))
    .replace('"@/lib/money"', JSON.stringify(here("../apps/ownership-planner/lib/money.ts").href));
  const file = join(mkdtempSync(join(tmpdir(), "decision-record-")), "DecisionRecord.mjs");
  writeFileSync(file, out);
  return (await import(pathToFileURL(file).href)).default;
}

// The real session's five screens and eleven tiers, in the order shown.
const MAINT = "Keep ownership manageable";
const FAMILIES = [
  {
    code: "PPM", goal: MAINT, tierInForce: "66_7", decision: "Managed by Customer", price: 421,
    tiers: [
      { code: "66_7", name: "Priority Maintenance, Bronze", term: "1 year" },
      { code: "78_7", name: "Priority Maintenance, Silver", term: "1 year" },
      { code: "72_7", name: "Priority Maintenance, Gold", term: "2 years" },
      { code: "84_7", name: "Priority Maintenance, Platinum", term: "3 years" },
    ],
  },
  {
    code: "VSA", goal: MAINT, tierInForce: "16_3", decision: "Managed by Customer", price: 1219,
    tiers: [
      { code: "16_3", name: "Mechanical Protection", term: "4 years" },
      { code: "86_3", name: "Mechanical Protection, Service Drive", term: "1 year" },
    ],
  },
  {
    code: "TAW", goal: "Keep ownership enjoyable", tierInForce: "23_4", decision: "Included", price: 920,
    tiers: [{ code: "23_4", name: "Tire and Wheel Protection", term: "4 years" }],
  },
  {
    code: "THP", goal: "Keep the asset valuable", tierInForce: "24_5", decision: "Managed by Customer", price: 469,
    tiers: [
      { code: "24_5", name: "Theft Protection, Plan A", term: "3 years" },
      { code: "25_5", name: "Theft Protection, Plan B", term: "3 years" },
    ],
  },
  {
    code: "BAT", goal: "Keep ownership enjoyable", tierInForce: "755_6", decision: "Included", price: 335,
    tiers: [
      { code: "755_6", name: "Battery Protection, Standard", term: "10 years" },
      { code: "754_6", name: "Battery Protection, Plus", term: "10 years" },
    ],
  },
];

// Deal 13759's finance terms, as planner-cap uses them.
const PRINCIPAL = 27547.64;
const RATE = 6.99;
const TERM = 60;

test("2 chosen and 9 declined: all 11 are listed, grouped by screen", () => {
  const groups = decisionRecord(FAMILIES);
  const lines = groups.flatMap((g) => g.lines);

  assert.equal(groups.length, 5);
  assert.deepEqual(groups.map((g) => g.position), [
    "Option 1 of 5", "Option 2 of 5", "Option 3 of 5", "Option 4 of 5", "Option 5 of 5",
  ]);
  assert.equal(groups[2].goal, "Keep ownership enjoyable");
  assert.equal(lines.length, 11);

  const chosen = lines.filter((l) => l.chosen);
  assert.deepEqual(
    chosen.map((l) => [l.name, l.term, l.price, l.decision]),
    [
      ["Tire and Wheel Protection", "4 years", 920, "Chosen"],
      ["Battery Protection, Standard", "10 years", 335, "Chosen"],
    ]
  );

  const declined = lines.filter((l) => !l.chosen);
  assert.equal(declined.length, 9);
  for (const l of declined) {
    assert.equal(l.decision, "Declined", `${l.name} should read Declined`);
    // A declined plan shows no price: the customer is not paying it.
    assert.equal(l.price, null);
  }
  // The other tier in a family the customer included is declined too.
  assert.equal(lines.find((l) => l.code === "754_6").decision, "Declined");
});

test("a family nobody has decided yet is not called declined", () => {
  const [g] = decisionRecord([{ ...FAMILIES[0], decision: undefined }]);
  assert.ok(g.lines.every((l) => l.decision === "Not yet decided"));
});

test("the screen renders all 11 with the right decision, prices and payment", async () => {
  const DecisionRecord = await loadDecisionRecord();
  const totals = planTotals(PRINCIPAL, [920, 335], RATE, TERM, null);
  const html = render(
    DecisionRecord({ groups: decisionRecord(FAMILIES), planTotal: toCents(920 + 335), totals, isCash: false })
  );

  const decisions = [...html.matchAll(/data-decision="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(decisions.length, 11);
  assert.equal(decisions.filter((d) => d === "Chosen").length, 2);
  assert.equal(decisions.filter((d) => d === "Declined").length, 9);

  for (const f of FAMILIES) for (const t of f.tiers) {
    assert.ok(html.includes(`<b>${t.name}</b>`), `${t.name} is missing`);
  }
  assert.match(html, /<b>\$920\.00<\/b><small>Chosen<\/small>/);
  assert.match(html, /<b>\$335\.00<\/b><small>Chosen<\/small>/);
  // Declined plans' prices are not printed.
  for (const p of ["$421.00", "$1,219.00", "$469.00"]) assert.ok(!html.includes(p), `${p} printed`);
  assert.equal((html.match(/>Declined</g) ?? []).length, 9);
  for (const g of ["Option 1 of 5", "Option 5 of 5", "Keep the asset valuable"]) assert.ok(html.includes(g));

  // The totals are the Payment Plan step's figures, to the cent.
  assert.match(html, /<dt>Protection chosen<\/dt><dd>\$1,255\.00<\/dd>/);
  assert.ok(html.includes(`<dt>Monthly payment without protection</dt><dd>${money(totals.vehiclePayment)}</dd>`));
  assert.ok(html.includes(`<dt>Monthly payment with protection</dt><dd>${money(totals.totalPayment)}</dd>`));
  assert.ok(totals.totalPayment > totals.vehiclePayment);
  // The plan's own payment is the difference, so the two figures reconcile.
  assert.equal(toCents(totals.totalPayment - totals.vehiclePayment), totals.planPayment);
});

test("a cash deal shows what protection costs and says there is no payment", async () => {
  const DecisionRecord = await loadDecisionRecord();
  const html = render(
    DecisionRecord({ groups: decisionRecord(FAMILIES), planTotal: 1255, totals: null, isCash: true })
  );
  assert.match(html, /<dt>Protection chosen<\/dt><dd>\$1,255\.00<\/dd>/);
  assert.match(html, /<dt>Monthly payment<\/dt><dd>None, paid outright<\/dd>/);
  assert.doesNotMatch(html, /without protection/);
});

test("the acknowledgment screen shows the record and keeps the existing copy", () => {
  const planner = src("../apps/ownership-planner/app/plan/[sessionId]/Planner.tsx");
  const ack = planner.slice(planner.indexOf('screen.kind === "ack"'), planner.indexOf("function surchargeCost("));

  assert.match(ack, /<h2 className="panel-head">What you were shown, and what you decided<\/h2>/);
  assert.match(ack, /It lists every\s+plan you were shown, what you decided about each, and the payment\s+those decisions produce\./);
  assert.match(ack, /Protection plans are optional\./);
  assert.match(ack, /<DecisionRecord\s+groups=\{recordGroups\}\s+planTotal=\{planTotal\}\s+totals=\{totals\}\s+isCash=\{isCash\}\s+\/>\s+\{downSummary\}/);
  assert.match(ack, /Your dealership takes it from here\./);

  // The same totals the Payment Plan step renders, not a second calculation.
  assert.equal((planner.match(/planTotals\(/g) ?? []).length, 1);
  assert.match(planner, /<PaymentBreakdown totals=\{totals\} \/>/);
});

test("the session ID is kept for staff and not shown to the customer", () => {
  const planner = src("../apps/ownership-planner/app/plan/[sessionId]/Planner.tsx");
  const ack = planner.slice(planner.indexOf('screen.kind === "ack"'), planner.indexOf("function surchargeCost("));
  assert.match(ack, /<div className="panel panel--ack" data-session-id=\{session\.id\}>/);
  assert.doesNotMatch(ack, /Session \{session\.id\}/);
  // The only place the ID appears in this screen's markup is the attribute.
  assert.equal((ack.match(/\{session\.id\}/g) ?? []).length, 1);
});
