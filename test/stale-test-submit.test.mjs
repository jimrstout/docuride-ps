// A test session on the QA server may submit on an out-of-date rating
// (2026-10-28). Details says so in amber instead of blocking, the
// confirmation says it above the products, and the submit records a session
// event. A real session is still blocked. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import * as deno from "../supabase/functions/_shared/sale-date.ts";
import { RATING_OUT_OF_DATE, STALE_TEST_NOTE, submitBlock, submitCheck } from "../apps/ownership-planner/lib/submit-check.ts";
import { render } from "./_jsx-string.mjs";

const here = (rel) => new URL(rel, import.meta.url);
const read = (rel) => readFileSync(here(`../${rel}`), "utf8");
const NOTE = "The rating is out of date. This is a test session, so you can still submit.";

const sheet = (testOnQa, over = {}) => ({
  day: { submit_problem: null },
  rating: { out_of_date: true },
  contracts_panel: { confirmation: { test_at_maximum: testOnQa } },
  ...over,
});

test("a test session with an out-of-date rating can submit, with the note", () => {
  assert.deepEqual(submitCheck(sheet(true)), { block: null, note: NOTE });
  assert.equal(submitBlock(sheet(true)), null);
  // Not the sale day still blocks, test session or not.
  assert.deepEqual(submitCheck(sheet(true, { day: { submit_problem: "Not today." } })), { block: "Not today.", note: null });
  // A current rating needs no note.
  assert.deepEqual(submitCheck(sheet(true, { rating: { out_of_date: false } })), { block: null, note: null });
});

test("a real session with an out-of-date rating is still blocked", () => {
  assert.deepEqual(submitCheck(sheet(false)), { block: RATING_OUT_OF_DATE, note: null });
  assert.deepEqual(submitCheck({ day: { submit_problem: null }, rating: { out_of_date: true } }), { block: RATING_OUT_OF_DATE, note: null });
  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /if \(pricePolicy\(session, credentials\.api_base_url\) !== "Test at maximum"\) \{\s*return await refuse\(400, \{ error: stale \}\);\s*\}/);
});

test("the submit records the allowance before anything is sent, or sends nothing", () => {
  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /event: STALE_TEST_SUBMIT_EVENT,/);
  assert.match(submit, /created_by: renewedBy\(body\.submitted_by\),/);
  assert.match(submit, /if \(staleEventErr\) \{\s*return await refuse\(500, \{ error: `The test session allowance could not be recorded, so nothing was sent:/);
  assert.ok(submit.indexOf("event: STALE_TEST_SUBMIT_EVENT") < submit.indexOf("client.submitContract"));
  assert.equal(deno.STALE_TEST_SUBMIT_EVENT, "Submitted on an out-of-date rating: test session");
  // The person is named by the initials of whoever is signed in.
  assert.match(read("apps/ownership-planner/app/console-actions.ts"), /submitted_by: initialsFor\(operator\.email\),/);
  // "Test at maximum" is exactly a test session on the QA server (_shared/price-cap.ts).
  assert.match(read("supabase/functions/_shared/price-cap.ts"), /return session\.is_test === true && hostOf\(apiBaseUrl\) === QA_HOST \? "Test at maximum" : "Provider decides";/);
});

test("the note's wording, in amber beside the button", () => {
  assert.equal(STALE_TEST_NOTE, NOTE);
  assert.equal(deno.STALE_TEST_NOTE, NOTE);
  const modal = read("apps/ownership-planner/components/SubmitConfirm.tsx");
  assert.match(modal, /\) : note \? \(\s*<p className="vsubmit-note" role="status">\{note\}<\/p>/);
  assert.match(read("apps/ownership-planner/app/details/[sessionId]/page.tsx"), /note=\{submitNote\}/);
  const css = read("apps/ownership-planner/app/globals.css");
  assert.match(css, /\.vsubmit-note \{[^}]*background: var\(--warn-panel\); color: var\(--warn-fg\);/);
});

test("the confirmation shows the note above the products, and its figures are unchanged", async () => {
  const out = ts.transpileModule(read("apps/ownership-planner/components/SubmitSummary.tsx"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "JSXSHIM", module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
    .replace('"JSXSHIM/jsx-runtime"', JSON.stringify(here("./_jsx-string.mjs").href))
    .replace('"@/lib/money"', JSON.stringify(here("../apps/ownership-planner/lib/money.ts").href));
  const file = join(mkdtempSync(join(tmpdir(), "stale-summary-")), "SubmitSummary.mjs");
  writeFileSync(file, out);
  const { default: Summary } = await import(pathToFileURL(file).href);
  const c = {
    deal_number: "90001", buyer_name: "Sample Buyer", sale_date: "2026-10-28", sale_date_label: "28 Oct 2026", test_at_maximum: true,
    lines: [{ product_name: "Sample Product", vendor: "Sample Provider", term_months: 36, term_miles: null, customer_price: 349.99, customer_price_cents: 34999, rate_unique: "r1" }],
    total: 349.99, total_cents: 34999,
  };
  const withNote = render(Summary({ confirmation: c, changes: [], note: NOTE, titleId: "t" }));
  assert.ok(withNote.indexOf(NOTE) > 0 && withNote.indexOf(NOTE) < withNote.indexOf("Sample Product"));
  assert.ok(withNote.includes("$349.99"));
  assert.ok(!render(Summary({ confirmation: c, changes: [], titleId: "t" })).includes(NOTE));
  // The modal passes the same note, and still reads the rows the submit sends.
  assert.match(read("apps/ownership-planner/components/SubmitConfirm.tsx"), /<SubmitSummary confirmation=\{confirmation\} changes=\{changes\} note=\{note\} titleId="vconfirm-title" \/>/);
  assert.match(read("supabase/functions/fni-session-verify/index.ts"), /\.select\(SUBMIT_ROW_COLUMNS\)/);
});
