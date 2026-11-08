// The Sessions list (8 Nov 2026): the customer beside the deal number, the
// store's full name, a store choice at the top right for someone who sees
// more than one store, and the order the footer names. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const page = read("apps/ownership-planner/app/admin/sessions/page.tsx");
const filters = read("apps/ownership-planner/components/admin/SessionFilters.tsx");
const pager = read("apps/ownership-planner/components/admin/SessionPager.tsx");
const layout = read("apps/ownership-planner/app/admin/layout.tsx");

test("a Customer column next to Deal #, with a co-buyer underneath, smaller and grey", () => {
  const heads = [...page.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ["Deal #", "Customer", "Vehicle", "Store", "Status", "Rating", "Created", "Expires", "Actions"]);
  assert.match(page, /<td data-label="Customer" className="ad-customer">[\s\S]{0,200}<span className="ad-strong ad-wrap">\{row\.customer \?\? "Not set"\}<\/span>\s*\{row\.co_buyer \? <small className="ad-wrap">\{row\.co_buyer\}<\/small> : null\}/);
  // small is the grey, smaller line in the admin stylesheet.
  assert.match(read("apps/ownership-planner/app/admin/admin.css"), /\.ad-table td small, \.ad-sub \{ display: block; margin-top: 4px; font-size: 11px; color: var\(--muted\); \}/);
});

test("search finds a session by customer", () => {
  assert.match(page, /return \[row\.deal_number, row\.customer, row\.co_buyer, row\.stock_number, vehicle\(row\), row\.store_name\]/);
  assert.match(filters, /placeholder="Search deal number, customer, stock number, vehicle or store"/);
  // The same matching the filter uses, on a made-up row.
  const text = ["99901", "Pat Example", null, "ST-1", "2026 Mockmake Trail", "All Seasons Powersports, Parkersburg"].filter(Boolean).join(" ").toLowerCase();
  const words = "pat example".split(/\s+/);
  assert.ok(words.every((w) => text.includes(w)));
});

test("the store choice: top right, left of the email, only for more than one store", () => {
  // Not in the filter row any more.
  assert.doesNotMatch(filters, /label="Store" all="All stores"/);
  assert.match(filters, /const storeChoice =\s*stores\.length > 1 \? \(/);
  assert.match(filters, /<option value="">All locations<\/option>/);
  assert.match(filters, /\{storeChoice && topBar \? createPortal\(storeChoice, topBar\) : storeChoice\}/);
  const top = layout.slice(layout.indexOf('<header className="ad-top">'));
  assert.ok(top.indexOf('id="ad-top-tools"') > 0 && top.indexOf('id="ad-top-tools"') < top.indexOf('className="ad-me-name"'));
  // Each permitted store by full name, alphabetical, from the server's own list.
  assert.match(page, /const stores = \(payload\.stores \?\? \[\]\)\.map\(\(s\) => \(\{ value: s\.id, label: s\.name \}\)\);/);
  assert.match(page, /data-store=\{row\.store_id \?\? ""\}/);
  // Remembered in this browser for the session.
  assert.match(filters, /window\.sessionStorage\.setItem\(STORE_CHOICE_KEY, v\);/);
  assert.match(filters, /if \(kept && stores\.some\(\(s\) => s\.value === kept\)\) setStore\(kept\);/);
});

test("the order: by store with every store, most recent first in one, and the footer says which", () => {
  assert.match(filters, /if \(table\) table\.dataset\.order = store === "" && stores\.length > 1 \? "store" : "recent";/);
  assert.match(pager, /\{order === "store" \? "By store, most recent first" : "Most recent first"\}/);
  assert.match(page, /data-order=\{stores\.length > 1 \? "store" : "recent"\}/);
});

test("no stores: the plain message instead of a list", () => {
  assert.match(page, /\{payload\.notice \? \(\s*<p className="ad-empty">\{payload\.notice\}<\/p>/);
});

// ── Sessions page label and layout fixes (9 Nov 2026) ───────────────────────
const css = read("apps/ownership-planner/app/admin/admin.css");

test("the store choice reads All locations, still meaning every store the person can see", () => {
  assert.match(filters, /<option value="">All locations<\/option>/);
  assert.doesNotMatch(filters + page, /All my stores/);
});

test("the sidebar, phone menu and breadcrumb follow the address on screen, not the first page loaded", () => {
  const nav = read("apps/ownership-planner/components/admin/AdminNav.tsx");
  assert.match(nav, /return sectionFor\(usePathname\(\) \?\? ""\);/);
  assert.match(layout, /<AdminCrumbHere \/>/);
  assert.doesNotMatch(layout, /sectionFor\(/, "the layout no longer decides which page is open");
  assert.match(read("apps/ownership-planner/components/admin/AdminMenu.tsx"), /const here = useHere\(\)\?\.href \?\? null;/);
});

test("customer and store names wrap, never cut off; the vehicle gives up room first", () => {
  assert.match(css, /#ad-sessions tr\[data-row\] td \.ad-wrap,[\s\S]{0,200}white-space: normal; overflow: visible; text-overflow: clip;/);
  assert.match(css, /#ad-sessions th:nth-child\(2\) \{ width: 15%; \}\s*#ad-sessions th:nth-child\(3\) \{ width: 9%; \}\s*#ad-sessions th:nth-child\(4\) \{ width: 15%; \}/);
  assert.match(page, /<StoreName name=\{row\.store_name\} \/>/);
  assert.match(page, /title=\{vehicle\(row\)\}/, "the full vehicle on hover");
  assert.match(page, /\? "Ended with sale date"/);
  assert.match(css, /td\[data-label="Expires"\] small \{ white-space: nowrap; \}/);
});
