// Phones and narrow tablets (2026-10-27). The desktop is untouched: every
// small-screen rule sits behind a max-width media query.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shortText, SHORT_TEXT_CHARS } from "../apps/ownership-planner/lib/long-text.ts";

const src = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");

test("a long message is cut at a word, with ..., and a short one is left alone", () => {
  assert.equal(shortText("Rated, 9 products."), "Rated, 9 products.");
  const long = "Riders Advantage: TecAssured refused the rate request: Client received SOAP Fault from server: The formatter threw an exception while trying to deserialize the message.";
  const s = shortText(long);
  assert.ok(s.length <= SHORT_TEXT_CHARS + 3, s);
  assert.ok(s.endsWith("..."));
  assert.ok(long.startsWith(s.slice(0, -3)));
  assert.doesNotMatch(s, /\s\.\.\.$/);
  assert.equal(shortText("a ".repeat(10), 5), "a a a...");
});

test("LongText shows the whole message wide, and Show details on a phone", () => {
  const c = src("components/LongText.tsx");
  assert.match(c, /<details className="longtext-narrow">/);
  assert.match(c, /Show details/);
  const css = src("app/globals.css");
  assert.match(css, /@media \(max-width: 899px\) \{\s*\.longtext-wide \{ display: none; \}/);
});

test("every admin section is reachable from the Menu button on a small screen", () => {
  const menu = src("components/admin/AdminMenu.tsx");
  assert.match(menu, /sections\.map\(\(s\) =>/);
  assert.match(menu, /aria-expanded=\{open\}/);
  assert.match(menu, /e\.key === "Escape"/);
  assert.match(src("app/admin/layout.tsx"), /<AdminMenu sections=\{ADMIN_SECTIONS\}/);
  const css = src("app/admin/admin.css");
  assert.match(css, /\.ad-menu \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 767px\) \{[\s\S]*?\.ad-menu \{ display: block; \}/);
  assert.match(css, /\.ad-side \.ad-brand-sub, \.ad-side-foot, \.ad-nav \{ display: none; \}/);
});

test("the sessions list is cards on a small screen, with every fact and action", () => {
  const page = src("app/admin/sessions/page.tsx");
  for (const label of ["Store", "Status", "Rating", "Created", "Expires"]) assert.match(page, new RegExp(`data-label="${label}"`));
  assert.match(page, /className="ad-row-actions"/);
  assert.match(page, /<LongText text=\{r\.detail\} \/>/);
  const css = src("app/admin/admin.css");
  assert.match(css, /\.ad-scroll:has\(#ad-sessions\) \{ overflow: visible; \}/);
  assert.match(css, /#ad-sessions thead \{ display: none; \}/);
  // Inputs at 16px so an iPhone does not zoom; buttons 44px tall.
  assert.match(css, /font-size: 16px; min-height: 44px;/);
  assert.match(css, /\.ad-btn \{ min-height: 44px;/);
  // Search and filters stack.
  assert.match(css, /\.ad-toolbar \{ flex-direction: column; align-items: stretch;/);
});
