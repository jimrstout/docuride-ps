// The DocuRide PS admin area: one layout, one sign-in, one list of sections.
//
// Sessions and Wording moved here from "/" and "/settings". Those two paths
// still work and send people on, and every action that used to land on them
// now lands on the new pages with the same notices.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  ADMIN_HOME,
  ADMIN_SECTIONS,
  safeAdminPath,
  sectionFor,
  withNotice,
} from "../apps/ownership-planner/lib/admin-sections.ts";

const src = (f) => readFileSync(new URL(`../apps/ownership-planner/${f}`, import.meta.url), "utf8");

const layout = src("app/admin/layout.tsx");
const actions = src("app/console-actions.ts");

// ── Redirects ───────────────────────────────────────────────────────────────

test('"/" and "/settings" redirect to the new pages, carrying any query', () => {
  const root = src("app/page.tsx");
  assert.match(root, /redirect\(query \? `\/admin\/sessions\?\$\{query\}` : "\/admin\/sessions"\)/);
  const settings = src("app/settings/page.tsx");
  assert.match(settings, /redirect\(query \? `\/admin\/wording\?\$\{query\}` : "\/admin\/wording"\)/);
  // And /admin itself opens on Sessions.
  assert.match(src("app/admin/page.tsx"), /redirect\(ADMIN_HOME\)/);
  assert.equal(ADMIN_HOME, "/admin/sessions");
});

test("every action that landed on / or /settings lands on the new page", () => {
  assert.doesNotMatch(actions, /redirect\("\/(\?[^"]*)?"\)/, 'no redirect to "/" is left');
  assert.doesNotMatch(actions, /"\/settings/, 'no redirect to "/settings" is left');
  assert.doesNotMatch(actions, /revalidatePath\("\/"\)/);
  // The same notices as before, on the new paths.
  assert.equal(withNotice("/admin/sessions", "extendfailed"), "/admin/sessions?extendfailed=1");
  for (const n of ["denied", "slow", "broken"]) {
    assert.match(actions, new RegExp(`withNotice\\(next, "${n}"\\)`), n);
  }
  for (const n of ["bad", "extendfailed"]) {
    assert.match(actions, new RegExp(`withNotice\\(SESSIONS, "${n}"\\)`), n);
  }
  for (const n of ["saved", "savefailed"]) {
    assert.match(actions, new RegExp(`withNotice\\(WORDING, "${n}"\\)`), n);
  }
  assert.match(actions, /redirect\(`\$\{WORDING\}\?refused=\$\{encodeURIComponent/);
});

test("Verify's Session browser and sign-in links point at the admin area", () => {
  const verify = src("app/verify/[sessionId]/page.tsx");
  assert.doesNotMatch(verify, /href="\/"/);
  assert.match(verify, /<Link className="console-back" href="\/admin\/sessions" prefetch=\{false\}>\s*Session browser/);
});

// ── Sign-in ────────────────────────────────────────────────────────────────

test("/admin/* shows the sign-in form when signed out, and returns to the page", () => {
  // The layout checks once and, signed out, renders SignIn instead of the page.
  assert.match(layout, /const operator = await currentOperator\(\);\s*if \(!operator\) \{[\s\S]*?return <SignIn notice=\{[^}]+\} next=\{path\} \/>;/);
  assert.match(src("components/admin/SignIn.tsx"), /<input type="hidden" name="next" value=\{next\} \/>/);
  assert.match(src("components/admin/SignIn.tsx"), /<form className="ad-panel" action=\{signIn\}>/);
  // signIn sends them back to it.
  assert.match(actions, /const next = safeAdminPath\(formData\.get\("next"\)\);/);
  assert.match(actions, /CONSOLE_COOKIE_OPTIONS\s*\);\s*redirect\(next\);/);
  // Each page reads the same cached answer before fetching anything.
  for (const page of ["app/admin/sessions/page.tsx", "app/admin/wording/page.tsx"]) {
    const p = src(page);
    const check = p.indexOf("if (!operator) return null;");
    const fetchAt = Math.max(p.indexOf("edge.adminSessions"), p.indexOf("edge.adminSettings"));
    assert.ok(check > 0, `${page} checks the operator`);
    assert.ok(p.lastIndexOf("export default") < check, `${page} checks in its default export`);
    assert.ok(fetchAt > 0);
  }
  assert.match(src("lib/admin-session.ts"), /export const currentOperator = cache\(/);
  // The path the layout reads is set by middleware, for /admin only.
  const mw = src("middleware.ts");
  assert.match(mw, /headers\.set\("x-admin-path", req\.nextUrl\.pathname\)/);
  assert.match(mw, /matcher: \["\/admin\/:path\*"\]/);
});

test("signing in can only return to a page inside the admin area", () => {
  assert.equal(safeAdminPath("/admin/wording"), "/admin/wording");
  assert.equal(safeAdminPath("/admin/wording?denied=1"), "/admin/wording");
  assert.equal(safeAdminPath("/admin"), ADMIN_HOME);
  for (const bad of ["//evil.example", "https://evil.example/admin", "/plan/x", "/admin//x",
    "/admin/../plan", "\\\\evil", null, undefined, 42]) {
    assert.equal(safeAdminPath(bad), ADMIN_HOME, String(bad));
  }
});

// ── The section list ─────────────────────────────────────────────────────────

test("the menu renders from the one list in code", () => {
  assert.match(layout, /\{ADMIN_SECTIONS\.map\(\(s\) => \(/);
  // The brand, and the signed-in email with Sign out beside it.
  assert.match(src("components/admin/Parts.tsx"), /DocuRide <span>PS<\/span>[\s\S]*Administration/);
  assert.match(layout, /<Brand \/>/);
  assert.match(layout, /<span className="ad-side-email">\{operator\.email\}<\/span>\s*\{signOutForm\}/);
  assert.match(layout, /<form action=\{signOut\}>/);
  assert.deepEqual(ADMIN_SECTIONS.map((s) => s.label).slice(0, 1), ["Sessions"]);
  assert.ok(ADMIN_SECTIONS.some((s) => s.label === "Wording"));
  // Only built sections: each one has a page.
  for (const s of ADMIN_SECTIONS) {
    assert.ok(
      existsSync(new URL(`../apps/ownership-planner/app${s.href}/page.tsx`, import.meta.url)),
      `${s.href} has a page`
    );
  }
  // The section in force is highlighted.
  assert.equal(sectionFor("/admin/wording")?.label, "Wording");
  assert.equal(sectionFor("/admin/sessions/anything")?.label, "Sessions");
  assert.match(layout, /aria-current=\{s\.href === here\?\.href \? "page" : undefined\}/);
});

test("the old pages keep no copy of their own", () => {
  // Sessions and Wording behave as before, from their new homes.
  const sessions = src("app/admin/sessions/page.tsx");
  assert.match(sessions, /edge\.adminSessions<ConsoleListPayload>\(LIMIT\)/);
  assert.match(sessions, /extendSession/);
  assert.match(sessions, /rateSession/);
  const wording = src("app/admin/wording/page.tsx");
  assert.match(wording, /<form action=\{saveSettings\} className="ad-form">/);
  assert.doesNotMatch(src("app/page.tsx"), /edge\.|currentOperator/);
  assert.doesNotMatch(src("app/settings/page.tsx"), /edge\.|currentOperator/);
});

test("the admin area is never served from a shared cache", () => {
  assert.match(src("next.config.mjs"), /source: "\/admin\/:path\*",\s*headers: \[\{ key: "Cache-Control", value: "no-store, private" \}\]/);
});
