// Page changes show busy from the press until the next page is drawn.
//
// Every link to a screen goes through components/Control.tsx. The instant it
// is pressed it shows "Opening..." with a spinner, is disabled, and a bar runs
// across the top; a second press of it, or of any other link, does nothing;
// and it stays that way until the next page's data is drawn. A link that opens
// a new tab waits for that tab to say its page is drawn.
//
// The same behaviour in a real browser (Sessions Open pressed twice opens one
// Details, busy within 100 ms on a throttled connection, the presentations'
// new tabs) is scripts/busy-check.mjs; the GitHub workflow has no browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NAV_GIVE_UP_MS, OPENING } from "../apps/ownership-planner/lib/nav-busy.ts";

const root = new URL("../apps/ownership-planner/", import.meta.url).pathname;
const app = (rel) => readFileSync(join(root, rel), "utf8");
const control = app("components/Control.tsx");
const nav = app("components/NavBusy.tsx");

function tsx(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsx(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

test("every link in the app is the shared control", () => {
  for (const f of [...tsx(join(root, "app")), ...tsx(join(root, "components"))]) {
    if (f.endsWith("components/Control.tsx")) continue;
    const s = readFileSync(f, "utf8");
    assert.doesNotMatch(s, /<Link\b|from "next\/link"/, f);
    assert.doesNotMatch(s, /<a\b/, f);
  }
});

test("pressed: busy at once, Opening..., disabled, and a second press does nothing", () => {
  assert.equal(OPENING, "Opening...");
  assert.match(control, /if \(!startNav\(self\.current, href, newTab\)\) \{\s*e\.preventDefault\(\);\s*return;\s*\}/);
  assert.match(control, /"aria-disabled": busy \|\| undefined,/);
  assert.match(control, /<span className="btn-spinner" aria-hidden="true" \/>\s*\{busyText\}/);
  // One page change at a time, across every link on the page.
  assert.match(nav, /export function startNav\(source: HTMLElement \| null, href: string, newTab: boolean\): boolean \{\s*if \(job\) return false;/);
  // The bar across the top, from the root layout.
  assert.match(nav, /return running \? <div className="nav-busy" role="progressbar" aria-label="Opening" \/> : null;/);
  assert.match(app("app/layout.tsx"), /<NavWatcher \/>/);
  assert.match(app("app/globals.css"), /a\[aria-disabled="true"\] \{ pointer-events: none; \}/);
});

test("it ends when the next page is drawn, not before", () => {
  // The router commits the next page (its data, then the address) in one
  // go; the watcher ends on the frame after that commit.
  assert.match(nav, /const finish = \(\) => requestAnimationFrame\(\(\) => navBusy\(\) === j && endNav\(\)\);/);
  // A loading screen means the data is still on the way: wait for the page.
  assert.match(nav, /const drawn = \(\) => !document\.querySelector\("\[data-page-loading\]"\);/);
  // A new tab ends it when that tab says its page is drawn.
  assert.match(nav, /if \(e\.data\?\.path === running\.to\) endNav\(\);/);
  assert.match(nav, /channel\.postMessage\(\{ path: window\.location\.pathname \+ window\.location\.search \}\);/);
  assert.match(app("app/layout.tsx"), /<DrawnSignal \/>/);
  // Never stuck: a lost signal gives up after a while.
  assert.ok(NAV_GIVE_UP_MS >= 30_000);
});

test("documents, other sites and in-page jumps do not wait for a page that never comes", () => {
  assert.match(control, /const external = file \|\| isOtherSite\(href\);/);
  assert.match(control, /if \(external \|\| inPage\) return;/);
  const details = app("app/details/[sessionId]/page.tsx");
  for (const doc of ["c.workdrive_url", "c.view_pdf_url", "o.contract.document_url"]) {
    assert.match(details, new RegExp(`<Control file href=\\{${doc.replace(/\./g, "\\.")}\\}>`), doc);
  }
});

test("the presentations open in a new tab and stay busy until it is drawn", () => {
  const details = app("app/details/[sessionId]/page.tsx");
  assert.match(details, /href=\{`\/menu\/\$\{sessionId\}`\} newTab>/);
  assert.match(details, /href=\{`\/plan\/\$\{sessionId\}`\} newTab>/);
});
