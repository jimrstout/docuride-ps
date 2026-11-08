// The Sessions list pages instead of scrolling.
//
// It shows as many sessions as fit the screen, worked out from the space the
// table has and each row's own height, with Previous, Next and a count
// ("1 to 5 of 6 sessions"). The paging controls hide when everything fits.
// Filters apply before paging, and changing one goes back to page 1. Rating
// still starts only on Details.
//
// The page arithmetic is tested here directly. The same behaviour in a real
// browser, at 1280x800, 1366x768, 1440x900 and 1920x1080 with 6 and 60 mock
// sessions, is scripts/sessions-paging-check.mjs (it needs Chromium, which
// the GitHub workflow does not have).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countLine, pageHolding, pagesFor } from "../apps/ownership-planner/lib/session-pages.ts";

const app = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");

test("as many rows as fit the space, by each row's own height", () => {
  // 400px of space, rows of 70px: five fit, the sixth starts page 2.
  assert.deepEqual(pagesFor([70, 70, 70, 70, 70, 70], 400), [[0, 1, 2, 3, 4], [5]]);
  // A taller row (a failed rating) takes more of the page.
  assert.deepEqual(pagesFor([70, 120, 70, 70, 70], 300), [[0, 1, 2], [3, 4]]);
  // Exactly full is full, not over.
  assert.deepEqual(pagesFor([100, 100, 100], 300), [[0, 1, 2]]);
  // Everything fits: one page.
  assert.deepEqual(pagesFor([50, 50, 50, 50, 50, 50], 1000), [[0, 1, 2, 3, 4, 5]]);
  assert.deepEqual(pagesFor([], 400), []);
});

test("every session is on exactly one page, even one taller than the space", () => {
  const heights = Array.from({ length: 60 }, (_, i) => (i % 4 === 1 ? 97 : 59));
  for (const available of [180, 330, 417, 520, 800]) {
    const flat = pagesFor(heights, available).flat();
    assert.deepEqual(flat, heights.map((_, i) => i), `${available}px`);
  }
  assert.deepEqual(pagesFor([50, 900, 50], 400), [[0], [1], [2]]);
});

test("after a re-measure, the page still holds the session that was at its top", () => {
  const pages = [[0, 1, 2], [3, 4, 5], [6]];
  assert.equal(pageHolding(pages, 4), 1);
  assert.equal(pageHolding(pages, 6), 2);
  assert.equal(pageHolding(pages, null), 0);
  assert.equal(pageHolding(pages, 99), 0);
});

test("the count, in words", () => {
  assert.equal(countLine({ first: 1, last: 5, matching: 6, total: 6, paged: true }), "1 to 5 of 6 sessions");
  assert.equal(countLine({ first: 6, last: 6, matching: 6, total: 6, paged: true }), "6 to 6 of 6 sessions");
  assert.equal(countLine({ first: 1, last: 6, matching: 6, total: 6, paged: false }), "6 sessions");
  assert.equal(countLine({ first: 1, last: 1, matching: 1, total: 1, paged: false }), "1 session");
  assert.equal(countLine({ first: 1, last: 2, matching: 2, total: 6, paged: false }), "2 of 6 sessions");
  assert.equal(countLine({ first: 1, last: 5, matching: 30, total: 60, paged: true }), "1 to 5 of 30 sessions, from 60");
});

test("filters apply first and send the pager back to page 1", () => {
  const filters = app("components/admin/SessionFilters.tsx");
  assert.match(filters, /tr\.dataset\.match = ok \? "1" : "0";/);
  assert.doesNotMatch(filters, /tr\.hidden =/, "the pager, not the filters, decides what shows");
  assert.match(filters, /window\.dispatchEvent\(new Event\(FILTERED_EVENT\)\)/);
  const pager = app("components/admin/SessionPager.tsx");
  assert.match(pager, /const onFiltered = \(\) => layout\("first"\);/);
  assert.match(pager, /const matching = rows\.filter\(\(r\) => r\.dataset\.match !== "0"\);/);
  // Measured from the space the table has, minus its header.
  assert.match(pager, /const available = scroller\.clientHeight - head;/);
  assert.match(pager, /split = pagesFor\(heights, available\);/);
});

test("Previous and Next only when there is more than one page", () => {
  const pager = app("components/admin/SessionPager.tsx");
  assert.match(pager, /const paged = view\.pages > 1;/);
  assert.match(pager, /\{paged \? \(\s*<span className="ad-pager" role="group" aria-label="Pages">/);
  assert.match(pager, />\s*Previous\s*<\/Control>/);
  assert.match(pager, />\s*Next\s*<\/Control>/);
  // The footer is the same height either way, so showing them never changes what fits.
  assert.match(app("app/admin/admin.css"), /\.ad-panel:has\(#ad-sessions\) \.ad-panel-foot \{ min-height: 50px;/);
});

test("nothing scrolls on a laptop, not even inside the panel", () => {
  const css = app("app/admin/admin.css");
  assert.match(css, /\.ad:has\(#ad-sessions\) \.ad-scroll:has\(#ad-sessions\) \{ flex: 1 1 auto; min-height: 0; overflow: hidden; \}/);
  assert.doesNotMatch(css, /\.ad-scroll:has\(#ad-sessions\) \{[^}]*overflow: auto/);
  // The pager pages only where the stylesheet fits the list to the window.
  assert.match(app("components/admin/SessionPager.tsx"), /const FITS = "\(min-width: 900px\) and \(min-height: 600px\)";/);
});

test("the list still has no Rate: rating starts only on Details", () => {
  const page = app("app/admin/sessions/page.tsx");
  assert.doesNotMatch(page, /rateSession|adminRate|>\s*Rate\s*</);
  assert.match(page, /<SessionPager tableId="ad-sessions" total=\{rows\.length\} byStore=\{stores\.length > 1\} \/>/);
});

// ── Next and Previous never skip a session (8 Nov 2026) ───────────────────
test("moving a page starts at the row after the last one shown, even when rows measure differently", async () => {
  const { pagesFor: pf, pagesFrom } = await import("../apps/ownership-planner/lib/session-pages.ts");
  // Page 1 was laid out with 4 rows; measured again, 5 would fit, so a fresh
  // split's second page would start at row 5 and row 4 would never show.
  assert.deepEqual(pf([80, 80, 80, 80, 80, 80], 400)[1], [5]);
  const { pages, at } = pagesFrom([80, 80, 80, 80, 80, 80], 400, 4);
  assert.deepEqual(pages[at], [4, 5]);
  assert.deepEqual(pages.flat(), [0, 1, 2, 3, 4, 5]);
  // Back to the first row of the page before.
  const back = pagesFrom([80, 80, 80, 80, 80, 80], 400, 0);
  assert.equal(back.at, 0);
  assert.deepEqual(back.pages[0], [0, 1, 2, 3, 4]);
  // A start past the end lands on the last page.
  assert.equal(pagesFrom([80, 80], 400, 2).at, 0);
});
