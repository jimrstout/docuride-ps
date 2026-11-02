// Sign-in required for every staff screen.
//
// Details, Prepare presentation and the staff panels used to open from a bare
// link. Now each shows the sign-in form in place, before anything about the
// deal is read, and returns to the same screen after. The customer's tabs
// inherit the staff member's sign-in and never show a form or a way in. The
// Next server forwards the sign-in to the Edge Functions on every call; the
// functions' own check is test/staff-sign-in-functions.test.mjs.
//
// Mock data only: made-up ids, no real deal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { safeStaffPath } from "../apps/ownership-planner/lib/admin-sections.ts";

const SESSION = "5e55e55e-5e55-4e55-8e55-5e55e55e5e55";
const app = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");
const fn = (name) => readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");

// ── The screens ────────────────────────────────────────────────────────────

test("the CRM launch still lands on Details", () => {
  const start = fn("fni-session-start");
  assert.match(start, /menu_url: `\$\{verifyBaseUrl\}\/\$\{sessionId\}`/);
  assert.match(app("next.config.mjs"), /source: "\/verify\/:path\*", destination: "\/details\/:path\*"/);
});


test("the Next server forwards the staff sign-in on every Edge Function call", () => {
  const edge = app("lib/edge.ts");
  assert.match(edge, /const STAFF_HEADER = "x-staff-session";/);
  assert.match(edge, /\.\.\.\(staff \? \{ \[STAFF_HEADER\]: staff \} : \{\}\)/);
});

function beforeAnyEdgeCall(src, marker) {
  const body = src.slice(src.indexOf(marker));
  const gate = body.indexOf("if (!operator)");
  const firstEdge = body.search(/edge\.[a-zA-Z]+[<(]/);
  assert.ok(gate > 0 && gate < firstEdge, `${marker}: signed-out check before the first read`);
  return body.slice(gate, firstEdge);
}

test("Details, signed out: the sign-in form in place, before the deal is read, back to the same deal after", () => {
  const p = app("app/details/[sessionId]/page.tsx");
  const gate = beforeAnyEdgeCall(p, "export default async function DetailsPage");
  assert.match(gate, /<SignIn\s/);
  assert.match(gate, /next=\{isSessionId\(sessionId\) \? `\/details\/\$\{sessionId\}` : "\/admin\/sessions"\}/);
  assert.doesNotMatch(gate, /deal_number|buyer|sheet\./);
  // The tab title names no deal either.
  const meta = p.slice(p.indexOf("export async function generateMetadata"), p.indexOf("export default async function DetailsPage"));
  assert.ok(meta.indexOf('return { title: "Sign in" }') < meta.indexOf("edge.verifySheet"));
});

test("Prepare, signed out: the sign-in form in place, back to the same deal's Prepare", () => {
  const gate = beforeAnyEdgeCall(app("app/prepare/[sessionId]/page.tsx"), "export default async function PreparePage");
  assert.match(gate, /<SignIn\s/);
  assert.match(gate, /`\/prepare\/\$\{sessionId\}`/);
});

test("the sign-in returns to the exact screen asked for, and nowhere a link could steer it", () => {
  assert.equal(safeStaffPath(`/details/${SESSION}`), `/details/${SESSION}`);
  assert.equal(safeStaffPath(`/prepare/${SESSION}`), `/prepare/${SESSION}`);
  assert.equal(safeStaffPath(`/details/${SESSION}?denied=1`), `/details/${SESSION}`);
  assert.equal(safeStaffPath("/admin/pricing"), "/admin/pricing");
  for (const bad of ["https://evil.example/", "//evil.example", `/plan/${SESSION}`, `/menu/${SESSION}`, "/details/../admin", "/details/not-a-session", null]) {
    assert.equal(safeStaffPath(bad), "/admin/sessions", String(bad));
  }
  assert.match(app("app/console-actions.ts"), /const next = safeStaffPath\(formData\.get\("next"\)\);/);
});

test("CRM launch while signed out: arrives with the cookie when there is one, and signs in back to Details", () => {
  // Lax, so the top-level arrival from the CRM carries an existing sign-in.
  assert.match(app("lib/console-cookie.ts"), /sameSite: "lax" as const/);
  // No cookie: Details shows the form with next=/details/<id>, and signIn
  // redirects to exactly that (tested above).
  assert.match(app("app/console-actions.ts"), /redirect\(next\);/);
});

test("the customer's tabs: inherit the sign-in, never show a form, never link to a staff screen", () => {
  for (const [f, marker] of [["app/plan/[sessionId]/page.tsx", "export default async function PlanPage"], ["app/menu/[sessionId]/page.tsx", "export default async function MenuPage"]]) {
    const src = app(f);
    const body = src.slice(src.indexOf(marker));
    const gate = body.indexOf("if (!(await currentOperator()))");
    assert.ok(gate > 0 && gate < body.indexOf("edge."), `${f}: checked before any read`);
    assert.match(body.slice(gate, gate + 300), /<Gate[^>]*title=\{CUSTOMER_TAB_SIGNED_OUT\.title\}/);
    assert.doesNotMatch(src, /SignIn|admin\.css|staff-gate\.ts/, f);
  }
  for (const f of ["app/plan/[sessionId]/page.tsx", "app/plan/[sessionId]/Planner.tsx", "app/plan/[sessionId]/Gate.tsx", "app/menu/[sessionId]/page.tsx", "app/menu/[sessionId]/Menu.tsx", "lib/staff-gate-copy.ts"]) {
    assert.doesNotMatch(app(f), /href=\{?[`"']\/(details|prepare|admin|verify)\b/, f);
    assert.doesNotMatch(app(f), /^import .*SignIn/m, f);
  }
  assert.doesNotMatch(app("lib/staff-gate-copy.ts"), /^import /m);
});

test("the customer's tabs' own requests need the same sign-in", () => {
  assert.match(app("lib/route-helpers.ts"), /if \(!\(await currentOperator\(\)\)\) \{\n\s+return \{ ok: false as const, response: noStore\(\{ error: "Not signed in" \}, 401\) \};/);
  for (const f of readdirSync(new URL("../apps/ownership-planner/app/api/", import.meta.url), { recursive: true }).filter((p) => p.endsWith("route.ts"))) {
    const src = app(`app/api/${f}`);
    if (src.includes("requireSessionId(")) assert.match(src, /await requireSessionId\(/, f);
  }
});

test("the line asking an already signed-in person to sign in is gone, with the other dead sign-in prompts", () => {
  const p = app("app/details/[sessionId]/page.tsx");
  assert.doesNotMatch(p, /Sign in to see and correct who goes on the contracts/);
  assert.doesNotMatch(p, /Sign in to (void|submit|record)|to clear it\./);
});
