// A confirmation before Submit (2026-10-28). Pressing "Submit contracts" opens
// a modal and sends nothing; only Confirm Submit sends. The modal's figures
// are the ones the submit sends, from the same rows and the same function.
// Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { savedSelections, submitConfirmation, SUBMIT_ROW_COLUMNS } from "../supabase/functions/_shared/saved-selections.ts";
import { money } from "../apps/ownership-planner/lib/money.ts";
import { render } from "./_jsx-string.mjs";

const here = (rel) => new URL(rel, import.meta.url);
const read = (rel) => readFileSync(here(`../${rel}`), "utf8");
const MODAL = "apps/ownership-planner/components/SubmitConfirm.tsx";

/** components/SubmitSummary.tsx, transpiled and rendered through the string runtime. */
async function loadSummary() {
  const out = ts.transpileModule(read("apps/ownership-planner/components/SubmitSummary.tsx"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "JSXSHIM", module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
    .replace('"JSXSHIM/jsx-runtime"', JSON.stringify(here("./_jsx-string.mjs").href))
    .replace('"@/lib/money"', JSON.stringify(here("../apps/ownership-planner/lib/money.ts").href));
  const file = join(mkdtempSync(join(tmpdir(), "submit-summary-")), "SubmitSummary.mjs");
  writeFileSync(file, out);
  return await import(pathToFileURL(file).href);
}

/** The customer's Included choices, as selected_products holds them. Prices pick at floating point. */
const ROWS = [
  { provider_product_id: "p1", rate_unique_id: "r1", selected_options: [], customer_price: "349.99", retail_price: "400.00", product_name: "RA BATTERY STANDARD USED - RIDERS ADVANTAGE BATTERY", term_months: 36, term_miles: null, providers: { name: "Sample Provider", contract_method: "Through API" } },
  { provider_product_id: "p2", rate_unique_id: "r2", selected_options: ["o1"], customer_price: 0.1, retail_price: null, product_name: "Tire and Wheel", term_months: 24, term_miles: 24000, providers: { name: "Sample Provider", contract_method: "Through API" } },
  { provider_product_id: "p3", rate_unique_id: "r3", selected_options: [], customer_price: 0.2, retail_price: null, product_name: "Theft", term_months: null, term_miles: null, providers: { name: "Other Provider", contract_method: "Through API" } },
  { provider_product_id: "p4", rate_unique_id: "r4", selected_options: [], customer_price: 1450.1, retail_price: null, product_name: "Care Coverage", term_months: 60, term_miles: 60000, providers: { name: "Sample Provider", contract_method: "Through API" } },
  // An OEM product: recorded by staff, never sent, so never in the confirmation.
  { provider_product_id: "p5", rate_unique_id: "r5", selected_options: [], customer_price: 999.99, retail_price: null, product_name: "OEM Plan", term_months: 12, term_miles: null, providers: { name: "Sample OEM", contract_method: "Recorded by Staff" } },
];

test("the modal's prices and total are the submit payload's, to the penny", () => {
  const c = submitConfirmation(ROWS);
  const sent = savedSelections(ROWS).filter((s) => s.rate_unique !== "r5");
  assert.deepEqual(c.lines.map((l) => l.rate_unique), sent.map((s) => s.rate_unique));
  for (const [i, s] of sent.entries()) {
    assert.equal(c.lines[i].customer_price, s.retail_price);
    assert.equal(c.lines[i].customer_price_cents, Math.round(s.retail_price * 100));
  }
  // Summed in cents: 349.99 + 0.10 + 0.20 + 1450.10, with no floating-point drift.
  assert.equal(c.total_cents, 34999 + 10 + 20 + 145010);
  assert.equal(c.total, 1800.39);
  assert.equal(money(c.total), "$1,800.39");
  assert.notEqual(0.1 + 0.2, 0.3); // the drift a dollar sum would have
  // The vendor is the product's provider record.
  assert.deepEqual(c.lines.map((l) => l.vendor), ["Sample Provider", "Sample Provider", "Other Provider", "Sample Provider"]);
});

test("the modal and the submit read the same rows the same way", () => {
  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /\.from\("selected_products"\)[\s\S]{0,200}?\.select\(SUBMIT_ROW_COLUMNS\)\s*\.eq\("session_id", session_id\)\s*\.eq\("disposition", "Included"\);/);
  assert.match(submit, /body\.selections = savedSelections\(\(saved \?\? \[\]\) as unknown as SubmitRow\[\]\);/);
  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /\.from\("selected_products"\)\s*\.select\(SUBMIT_ROW_COLUMNS\)\s*\.eq\("session_id", s\.id as string\)\s*\.eq\("disposition", "Included"\)/);
  assert.match(verify, /\.\.\.submitConfirmation\(\(data \?\? \[\]\) as unknown as SubmitRow\[\]\),/);
  assert.match(verify, /confirmation: await submitConfirmationFor\(supabase, s, onQa\),/);
  // The buyer and sale date as the submit sends them: staff values applied.
  assert.match(verify, /const edited = applyStaffEdits\(s, parseStaffEdits\(s\.staff_edits\), editTargetFor\);\s*const sale = dealDates\(edited\)\.sale;/);
  assert.match(SUBMIT_ROW_COLUMNS, /customer_price, retail_price/);
});

test("the modal shows the deal, buyer, sale date, each product and the total", async () => {
  const { default: Summary, termText } = await loadSummary();
  const c = { deal_number: "90001", buyer_name: "Sample Buyer", sale_date: "2026-10-28", sale_date_label: "28 Oct 2026", test_at_maximum: false, ...submitConfirmation(ROWS) };
  const html = render(Summary({ confirmation: c, changes: [], titleId: "t" }));
  for (const s of ["90001", "Sample Buyer", "28 Oct 2026", "RA BATTERY STANDARD USED - RIDERS ADVANTAGE BATTERY", "Other Provider, No term", "Sample Provider, 24 months, 24,000 miles", "$349.99", "$0.10", "$1,450.10", "Total customer price", "$1,800.39"]) {
    assert.ok(html.includes(s), s);
  }
  assert.ok(!html.includes("OEM Plan"));
  assert.ok(!html.includes("Changed on Details"));
  assert.ok(!html.includes("test server"));
  assert.equal(termText({ term_months: 36, term_miles: null }), "36 months");
  // A QA test session goes at the provider's maximum, and says so.
  assert.ok(render(Summary({ confirmation: { ...c, test_at_maximum: true }, changes: [], titleId: "t" })).includes("at the most the provider allows"));
});

test("Submit contracts opens the modal and sends nothing; only Confirm Submit sends", () => {
  const m = read(MODAL);
  // The opener is a plain button: it shows the modal and submits nothing.
  assert.match(m, /<button type="button" className="btn" onClick=\{show\} disabled=\{!!blocked\} aria-haspopup="dialog">\s*Submit contracts\s*<\/button>/);
  assert.match(m, /const show = \(\) => \{\s*setTicked\(false\);\s*dialog\.current\?\.showModal\(\);\s*setOpen\(true\);\s*\};/);
  // The one control that sends the form is Confirm Submit, and only while the modal is open.
  // The other is the spent-rate refresh, which sends to refreshSpentRates, never to submitContracts.
  assert.equal((m.match(/<PendingButton/g) ?? []).length, 2);
  assert.match(m, /<PendingButton\s+className="btn"\s+working="page"\s+pending="Refreshing the rating\.\.\."\s+formAction=\{refreshSpentRates\}/);
  assert.doesNotMatch(m, /type="submit"|requestSubmit|\.submit\(\)/);
  assert.match(m, /disabled=\{!open \|\| !!blocked \|\| !!held \|\| \(needsDx1 && !ticked\)\}\s*>\s*Confirm Submit\s*</);
  assert.match(m, /<form action=\{submitContracts\} ref=\{form\} className="vsubmit">\s*<Working \/>/);
  const page = read("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.doesNotMatch(page, /<form action=\{submitContracts\}/);
  assert.match(page, /<SubmitConfirm\s/);
});

test("Cancel closes the modal and sends nothing", () => {
  const m = read(MODAL);
  assert.match(m, /<button type="button" className="btn btn--quiet" onClick=\{cancel\} disabled=\{busy\}>\s*Cancel\s*<\/button>/);
  assert.match(m, /const cancel = \(\) => \{\s*if \(!busy\) dialog\.current\?\.close\(\);\s*\};/);
  // Escape is a cancel too, refused only while a submit is running.
  assert.match(m, /onCancel=\{\(e\) => \{[\s\S]*?if \(busy\) e\.preventDefault\(\);\s*\}\}/);
});

test("the DMS confirmation is in the modal only when contract details were changed, and gates Confirm", async () => {
  const m = read(MODAL);
  assert.match(m, /const needsDx1 = changes\.length > 0;/);
  assert.match(m, /\{needsDx1 \? \(\s*<label className="vdx1-confirm vconfirm-dx1">\s*<input\s+type="checkbox"\s+name="dx1_confirmed"\s+value="1"\s+required\s+checked=\{ticked\}/);
  assert.match(m, /\{DX1_CONFIRMATION\}/);
  // Still recorded as a session event by the submit, which refuses without it.
  const actions = read("apps/ownership-planner/app/console-actions.ts");
  assert.match(actions, /formData\.get\("dx1_confirmed"\) === "1"/);
  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /event: "Contract detail changes confirmed for DX1",/);
  assert.match(submit, /if \(body\.dx1_confirmed !== true\) \{/);
  // The changes are listed in the modal.
  const { default: Summary } = await loadSummary();
  const c = { deal_number: "90001", buyer_name: "Sample Buyer", sale_date: null, sale_date_label: null, test_at_maximum: false, ...submitConfirmation(ROWS) };
  const html = render(Summary({ confirmation: c, changes: [{ key: "buyer_last_name", party: "Buyer", label: "Buyer last name", was: "Smaple", now: "Sample" }], titleId: "t" }));
  assert.ok(html.includes("Changed on Details"));
  assert.ok(html.includes("<strong>Buyer last name</strong>: Smaple to Sample"));
});

test("a double tap on Confirm Submit sends once", () => {
  const m = read(MODAL);
  // The page's busy button (PR 45): one spinner, one label, disabled while busy,
  // and the working area stops a second send of the running form.
  assert.match(m, /<PendingButton\s+className="btn btn--go"\s+working="page"\s+pending="Submitting contracts\.\.\."\s+leave=\{SUBMIT_LEAVE\}/);
  const b = read("apps/ownership-planner/components/PendingButton.tsx");
  assert.match(b, /disabled=\{disabled \|\| busy\}/);
  const w = read("apps/ownership-planner/components/Working.tsx");
  assert.match(w, /if \(state\.running\) \{[\s\S]*?e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);/);
  // The page veil would be a second spinner and label behind the modal.
  const css = read("apps/ownership-planner/app/globals.css");
  assert.match(css, /\.working-area:has\(dialog\.vconfirm\[open\]\) \+ \.working-overlay \{ display: none; \}/);
  // And the server takes one submit per session (fni-contract-submit's lock).
  assert.match(read("supabase/functions/fni-contract-submit/index.ts"), /\.eq\("submit_state", "Idle"\)/);
  // When the submit has answered the modal closes, so the result shows.
  assert.match(m, /else if \(wasBusy\.current\) \{\s*wasBusy\.current = false;\s*dialog\.current\?\.close\(\);/);
});

test("the modal fits a 390px phone: no sideways scroll, the list scrolls, the buttons stay in view", () => {
  const css = read("apps/ownership-planner/app/globals.css");
  assert.match(css, /\.vconfirm \{\s*width: min\(36rem, calc\(100vw - 32px\)\); max-width: none;\s*max-height: calc\(100dvh - 32px\);/);
  assert.match(css, /\.vconfirm\[open\] \{ display: flex; flex-direction: column; \}/);
  assert.match(css, /\.vconfirm-body \{\s*flex: 1 1 auto; min-height: 0; overflow-y: auto;[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.vconfirm-line \{\s*display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.vconfirm-actions \{\s*flex: none;/);
  assert.match(css, /@media \(max-width: 899px\) \{\s*\.vconfirm-actions \.btn \{ flex: 1 1 0; min-height: var\(--tap\); \}/);
});
