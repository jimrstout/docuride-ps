// Prepare presentation and Present menu, condensed (2 Nov testing, item 7).
//
// Content at most 1280px wide and centred under a full-width header; the row
// names only as wide as "Mechanical Protection"; cards that fit their content,
// the same height across a row, no empty band above their text; long names
// cut with "..." and the full text on hover. Measured in a real browser at
// 1280x800 to 1920x1080 with seven rows and four columns by
// scripts/layout-check.mjs (the GitHub workflow has no browser); these checks
// hold the rules that make it so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");
const SCREENS = [
  { name: "Prepare presentation", css: read("app/prepare/[sessionId]/prepare.css"), p: "pm" },
  { name: "Present menu", css: read("app/menu/[sessionId]/menu.css"), p: "mn" },
];

test("content at most 1280px wide and centred; the header stays full width", () => {
  for (const s of SCREENS) {
    assert.match(s.css, new RegExp(`\\.${s.p}-grid \\{[^}]*width: 100%; max-width: 1280px; margin-inline: auto;`), s.name);
    assert.doesNotMatch(s.css, new RegExp(`\\.${s.p}-head \\{[^}]*max-width`), s.name);
  }
});

test("one set of columns, the row names only as wide as Mechanical Protection", () => {
  for (const s of SCREENS) {
    assert.match(s.css, new RegExp(`grid-template-columns: max-content repeat\\(var\\(--${s.p}-cols\\), minmax\\(0, 1fr\\)\\);`), s.name);
    assert.match(s.css, new RegExp(`\\.${s.p}-row \\{\\s*grid-column: 1 / -1;\\s*display: grid;\\s*grid-template-columns: subgrid;`), s.name);
    assert.match(s.css, /max-width: 11em; overflow: hidden; text-overflow: ellipsis;/, s.name);
  }
});

test("cards fit their content, with no band above the text", () => {
  for (const s of SCREENS) {
    assert.match(s.css, new RegExp(`grid-template-rows: auto repeat\\(var\\(--${s.p}-rows\\), auto\\) auto;\\s*align-content: start;`), s.name);
  }
  assert.match(SCREENS[0].css, /\.pm-cell \{[^}]*align-content: start;/);
  assert.doesNotMatch(SCREENS[0].css, /\.pm-cell \{[^}]*align-content: center;/);
});

test("a long name ends in ... with the full text on hover", () => {
  const prepare = read("app/prepare/[sessionId]/Prepare.tsx");
  assert.match(prepare, /<span className="pm-plan" title=\{found\.plan\.plan_name\}>/);
  assert.match(prepare, /<span className="pm-sub" title=\{found\.option\.label\}>/);
  assert.match(prepare, /<div className="pm-label" title=\{category\}>/);
  assert.match(read("app/menu/[sessionId]/Menu.tsx"), /<span className="mn-label" role="rowheader" title=\{row\.label\}>/);
  assert.match(SCREENS[0].css, /\.pm-plan \{[^}]*text-overflow: ellipsis; white-space: nowrap;/);
});
