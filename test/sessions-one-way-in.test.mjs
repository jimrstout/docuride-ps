// The Sessions list has one way into a deal: its Details.
//
// Each row had Open, which went straight to the customer's storyboard, beside
// Details, which is where staff rate, prepare and present. Staff could not
// tell them apart, and Open skipped the Rate, then Prepare, then Present flow.
// Now each row has one button, Open, and it, the deal number and the vehicle
// all go to that session's Details. Nothing on the list opens a customer
// presentation, and nothing on it rates.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");
const page = app("app/admin/sessions/page.tsx");
const row = page.slice(page.indexOf("function Row("), page.indexOf("\n}\n", page.indexOf("function Row(")));
const cell = (marker) => row.slice(row.indexOf(marker), row.indexOf("</td>", row.indexOf(marker)));

test("Open lands on that session's Details, and it is the only button", () => {
  const actions = cell('<td className="ad-row-actions">');
  assert.match(actions, /<Link className="ad-btn ad-btn--secondary ad-btn--main" href=\{`\/details\/\$\{row\.id\}`\} prefetch=\{false\}>\s*Open\s*<\/Link>/);
  assert.equal((actions.match(/<Link|<a\s|<button|<form|<PendingButton/g) ?? []).length, 1, "one way in");
  assert.doesNotMatch(actions, />\s*Details\s*</, "the separate Details button is gone");
});

test("the deal number lands on that session's Details", () => {
  assert.match(cell('<td className="ad-deal">'), /<Link className="ad-rowlink" href=\{`\/details\/\$\{row\.id\}`\} prefetch=\{false\}>\s*\{row\.deal_number \?\? "Not set"\}\s*<\/Link>/);
});

test("the vehicle lands on that session's Details", () => {
  assert.match(cell('<td className="ad-vehicle">'), /<Link className="ad-rowlink ad-strong" href=\{`\/details\/\$\{row\.id\}`\} prefetch=\{false\} title=\{vehicle\(row\)\}>\s*\{vehicle\(row\)\}\s*<\/Link>/);
});

test("nothing on the list opens a customer presentation, rates, or opens a new tab", () => {
  assert.doesNotMatch(page, /\/plan\/|\/menu\/|\/prepare\//);
  assert.doesNotMatch(page, /target="_blank"/);
  assert.doesNotMatch(page, /rateSession|adminRate|<PendingButton/);
  // Every link a row has goes to Details.
  const hrefs = [...row.matchAll(/href=\{`([^`]+)`\}/g)].map((m) => m[1]);
  assert.ok(hrefs.length === 3, `three ways in, all to Details: ${hrefs.join(", ")}`);
  for (const h of hrefs) assert.equal(h, "/details/${row.id}");
  // The list-level Rate action is gone with its button.
  assert.doesNotMatch(app("app/console-actions.ts"), /export async function rateSession/);
});

test("the Actions column is narrow, and the list fits a laptop screen", () => {
  const css = app("app/admin/admin.css");
  const block = css.slice(css.indexOf("/* ── Sessions on one screen"));
  assert.match(block, /#ad-sessions th:nth-child\(8\) \{ width: 88px; \}/);
  assert.match(block, /#ad-sessions \{ table-layout: fixed; \}/);
  // The page is the window; more sessions than fit are paged, not scrolled
  // (test/sessions-paging.test.mjs).
  assert.match(block, /\.ad:has\(#ad-sessions\) \{ height: 100vh; height: 100dvh; min-height: 0; overflow: hidden; \}/);
});
