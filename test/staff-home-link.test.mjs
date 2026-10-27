// Every staff page has a way home: "DocuRide PS", linking to the main screen,
// as the first crumb of its top bar. The customer's menu never shows it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");

test("the home link is DocuRide PS and goes to the main screen", () => {
  const c = src("components/HomeLink.tsx");
  assert.match(c, /export const HOME_HREF = "\/";/);
  assert.match(c, /DocuRide <span>PS<\/span>/);
});

test("the admin area starts its breadcrumb with it, and the sidebar brand goes home too", () => {
  const l = src("app/admin/layout.tsx");
  const crumb = l.slice(l.indexOf('<p className="ad-crumb">'), l.indexOf("</p>", l.indexOf('<p className="ad-crumb">')));
  assert.ok(crumb.indexOf("<HomeLink />") < crumb.indexOf("Administration"));
  assert.match(l, /<Link href=\{HOME_HREF\} prefetch=\{false\} className="ad-brand-link">/);
});

test("the deal page starts its breadcrumb with it", () => {
  const p = src(existsDetails() ? "app/details/[sessionId]/page.tsx" : "app/verify/[sessionId]/page.tsx");
  const crumb = p.slice(p.indexOf('<nav aria-label="Breadcrumb">'), p.indexOf("</nav>", p.indexOf('<nav aria-label="Breadcrumb">')));
  assert.ok(crumb.startsWith('<nav aria-label="Breadcrumb">'));
  assert.ok(crumb.indexOf("<HomeLink />") < crumb.indexOf("Deal {sheet.session.deal_number"));
});

test("the customer's menu never shows it", () => {
  for (const f of ["app/plan/[sessionId]/page.tsx", "app/plan/[sessionId]/Planner.tsx", "app/plan/[sessionId]/Gate.tsx", "components/AppShell.tsx"]) {
    assert.doesNotMatch(src(f), /HomeLink/, f);
  }
});

function existsDetails() {
  try { src("app/details/[sessionId]/page.tsx"); return true; } catch { return false; }
}
