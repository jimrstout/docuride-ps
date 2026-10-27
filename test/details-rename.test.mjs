// "Verify" became "Details" (2026-10-27): the page holds the facts the menu
// runs on, the settings that shape it, and the record of contracts and
// documents afterward. The verification step inside it keeps its own words.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const app = new URL("../apps/ownership-planner/", import.meta.url).pathname;
const src = (rel) => readFileSync(join(app, rel), "utf8");
const page = src("app/details/[sessionId]/page.tsx");

test("the page lives at /details/<session id>", () => {
  assert.ok(existsSync(join(app, "app/details/[sessionId]/page.tsx")));
  assert.ok(!existsSync(join(app, "app/verify")));
});

test("/verify/<session id> redirects to it for good, so CRM links and bookmarks never break", () => {
  const cfg = src("next.config.mjs");
  assert.match(cfg, /\{ source: "\/verify\/:path\*", destination: "\/details\/:path\*", permanent: true \}/);
});

test("the tab, the breadcrumb and the heading say Details and the deal number", () => {
  assert.match(page, /title: deal \? `Deal \$\{deal\} Details` : "Details"/);
  assert.match(page, /<strong>Details<\/strong>/);
  assert.match(page, /<h1 className="sr-only">Deal \{sheet\.session\.deal_number \?\? "\(no number\)"\} details<\/h1>/);
});

test("the sessions list button reads Details", () => {
  const s = src("app/admin/sessions/page.tsx");
  assert.match(s, /href=\{`\/details\/\$\{row\.id\}`\} prefetch=\{false\}>\s*Details\s*<\/Link>/);
});

test("the verification step keeps its own wording", () => {
  assert.match(page, /Checked by/);
  assert.match(page, /Confirm and Continue/);
  assert.match(src("lib/verify-flash.ts"), /Verified and rated\./);
});

test("nothing in the app builds a /verify/ address any more", () => {
  const walk = (d) => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (f === "node_modules" || f === ".next") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|mjs)$/.test(f) ? [p] : [];
  });
  for (const f of [...walk(join(app, "app")), ...walk(join(app, "components")), ...walk(join(app, "lib"))]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /[`"']\/verify\//, f);
  }
});
