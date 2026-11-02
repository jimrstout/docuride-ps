// One shared control for every button and action link.
//
// components/Control.tsx is the only button in the app. Pressed, it disables,
// shows its working text, stays busy until the result is on the screen, and
// comes back with a plain-English error if it failed. The per-button busy code
// that grew up around the app (PendingButton, hand-written "Saving..." and
// spinners) is gone. The server's own guards against a second submit or void
// are unchanged.
//
// The same behaviour in a real browser, for Rate, Rate again, Save changes,
// Refresh from CRM and the customer's Select this package, is
// scripts/busy-check.mjs; the GitHub workflow has no browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { plainError, WORKING } from "../apps/ownership-planner/lib/control.ts";

const app = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");
const control = app("components/Control.tsx");

test("a failed press says so in plain English", () => {
  assert.equal(plainError(new Error("The menu could not be saved")), "The menu could not be saved.");
  assert.equal(plainError(new Error("Prices are locked.")), "Prices are locked.");
  assert.equal(plainError(new TypeError("Failed to fetch")), "Could not reach DocuRide. Check the connection and try again.");
  assert.equal(plainError(new Error("")), "That did not work. Try again.");
  assert.equal(plainError(new Error("TypeError: x is undefined")), "That did not work. Try again.");
  assert.equal(plainError(undefined), "That did not work. Try again.");
  assert.equal(WORKING, "Working...");
});

test("a press that returns a promise is busy until it settles, and comes back on error", () => {
  assert.match(control, /const result = onPress\(e\);\s*if \(!\(result instanceof Promise\)\) return;\s*setPressing\(true\);/);
  assert.match(control, /\} catch \(err\) \{\s*setError\(plainError\(err\)\);\s*\} finally \{\s*setPressing\(false\);\s*\}/);
  assert.match(control, /<span className="control-error" role="alert">/);
  // Disabled while busy, and a press while busy does nothing.
  assert.match(control, /disabled=\{disabled \|\| busy\}/);
  assert.match(control, /if \(busy\) \{\s*e\.preventDefault\(\);\s*return;\s*\}/);
});

test("a submit is busy until its answer is drawn, with no marker to forget", () => {
  // The page's working state (components/Working.tsx) is told when the form's
  // action has answered by a marker inside the button itself.
  assert.match(control, /\{type === "submit" \? <Working \/> : null\}/);
  assert.match(control, /data-working=\{type === "submit" \? working : undefined\}/);
  assert.match(control, /data-working-label=\{type === "submit" \? busyText : undefined\}/);
  // Two markers in one form end the job once.
  assert.match(app("components/Working.tsx"), /if \(!r \|\| r\.finishing\) return;\s*r\.finishing = true;/);
});

test("the per-button busy code is gone", () => {
  assert.equal(existsSync(new URL("../apps/ownership-planner/components/PendingButton.tsx", import.meta.url)), false);
  const prepare = app("app/prepare/[sessionId]/Prepare.tsx");
  assert.doesNotMatch(prepare, /pending \? "Saving\.\.\."|useTransition/);
  assert.match(prepare, /busyText="Saving\.\.\.">\s*Save\s*<\/Control>/);
  const menu = app("app/menu/[sessionId]/Menu.tsx");
  assert.doesNotMatch(menu, /phase === "saving" \? "One moment\.\.\."/);
  for (const f of ["components/OemContractRecord.tsx", "components/admin/SheetUpload.tsx"]) {
    assert.doesNotMatch(app(f), /btn-spinner|aria-busy=/, f);
  }
});

test("the server's double-submit guards stay", () => {
  const fn = (name) => readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");
  assert.match(fn("fni-contract-submit"), /\.eq\("submit_state", "Idle"\)/);
  assert.match(fn("fni-contract-void"), /claim/i);
  // And the page stops a second send of a running form before it leaves.
  assert.match(app("components/Working.tsx"), /if \(state\.running\) \{[\s\S]*?e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);/);
});
