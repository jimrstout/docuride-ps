// A busy button shows one spinner and one label (2026-10-27). A panel action
// started by a button inside that panel used to draw the label twice: the
// button's own, and the panel lock's over it. And a second tap on a running
// form could still send it, which is how one +24h could extend a session twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");

test("a panel whose own button is busy locks without a second label", () => {
  const w = src("components/Working.tsx");
  assert.match(w, /const quiet = !!\(panel && trigger && panel\.contains\(trigger\)\);/);
  assert.match(w, /if \(quiet\) panel\.classList\.add\("is-working--quiet"\);/);
  assert.match(w, /panel\.classList\.remove\("is-working", "is-working--quiet"\);/);
  const css = src("app/globals.css");
  assert.match(css, /\.is-working--quiet::before, \.is-working--quiet::after \{ content: none; \}/);
  assert.match(css, /\.is-working--quiet > :has\(\[data-working-trigger\]\), \.is-working--quiet > \[data-working-trigger\] \{ opacity: 1; \}/);
  assert.match(css, /button\.is-busy, \.btn\.is-busy, \.ad-btn\.is-busy, button\[aria-busy="true"\] \{ max-width: 100%; white-space: normal; overflow-wrap: anywhere; \}/);
  // A panel started from a button outside it (Details' Save changes) still says what it is doing.
  assert.match(css, /\.is-working::after \{\s*content: attr\(data-working-text\);/);
});

test("PendingButton shows one spinner and its working label, and is disabled while busy", () => {
  const b = src("components/PendingButton.tsx");
  assert.match(b, /disabled=\{disabled \|\| busy\}/);
  assert.match(b, /<span className="btn-spinner" aria-hidden="true" \/>\s*\{pending\}/);
});

test("a second tap on a running form is stopped before anything is sent", () => {
  const w = src("components/Working.tsx");
  assert.match(w, /if \(state\.running\.form === form && state\.running\.resendAllowed\) \{\s*state\.running\.resendAllowed = false;\s*return;\s*\}\s*e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);/);
  assert.match(w, /resendAllowed: false,/);
  assert.match(w, /function resend\(\) \{\s*if \(state\.running\) state\.running\.resendAllowed = true;\s*\}/);
  // The two forms that upload first and then save say when the save may go.
  for (const f of ["components/OemContractRecord.tsx", "components/admin/SheetUpload.tsx"]) {
    assert.match(src(f), /area\?\.resend\(\);\s*form\.current\?\.requestSubmit\(\);/, f);
  }
});
