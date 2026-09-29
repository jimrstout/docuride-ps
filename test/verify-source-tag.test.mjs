// The Verify sheet prints a row's source only when it is not the CRM.
//
// CRM is the expected answer, and printing it on nearly every row hid the
// exceptions the screen exists to catch. Display only: every field still
// carries its source in the data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const page = src("../apps/ownership-planner/app/verify/[sessionId]/page.tsx");
const css = src("../apps/ownership-planner/app/globals.css");

const sourceFn = page.slice(
  page.indexOf("function Source("),
  page.indexOf("\n}\n", page.indexOf("function Source(")) + 2
);

test("a CRM row prints no visible chip, but keeps its space and tells a screen reader", () => {
  assert.match(sourceFn, /if \(source === "CRM"\) \{/);
  assert.match(sourceFn, /<span className="tag tag--none" aria-hidden="true">CRM<\/span>/);
  assert.match(sourceFn, /<span className="sr-only">From the CRM\.<\/span>/);
  // Invisible, not removed, so rows with and without a chip line up.
  assert.match(css, /\.tag--none \{ visibility: hidden; \}/);
  assert.doesNotMatch(css, /\.tag--none \{[^}]*display: none/);
});

test("every other source keeps a visible chip, and Missing keeps its stronger style", () => {
  assert.match(sourceFn, /const tone = source === "Missing" \? "tag--expired" : "tag--quiet";/);
  assert.match(sourceFn, /return <span className=\{`tag \$\{tone\}`\}>\{source\}<\/span>;/);
  // No other source is hidden behind a hover.
  assert.equal((sourceFn.match(/tag--none/g) ?? []).length, 1);
});

test("a CRM row's tooltip still says where the value came from", () => {
  assert.match(page, /const origin = field\.note \?\? \(field\.source === "CRM" \? "From the CRM deal\." : null\);/);
  assert.match(page, /const tip = \[field\.label, origin, help\]\.filter\(Boolean\)\.join\(" "\);/);
  assert.match(page, /className=\{`vfield \$\{state\}`\} title=\{tip\}/);
});

test("the sheet says once that values come from the CRM unless marked", () => {
  assert.match(page, /<p className="vsheet-legend">Values come from the CRM unless marked\.<\/p>/);
  // Its own row across the desktop grid, so it never lands in a group's cell.
  assert.match(css, /grid-template-areas: "legend legend legend" "deal vehicle customer" "money vehicle customer";/);
  assert.match(css, /\.vsheet-legend \{ grid-area: legend; \}/);
});

test("the edit line under a field is unchanged", () => {
  assert.match(page, /Was <span className="vfield-was-value">\{field\.original \?\? "not set"\}<\/span>/);
  assert.match(page, /\{" "\}\(\{field\.original_source\}\), changed by \{field\.edited_by \?\? "unknown"\},\{" "\}/);
});
