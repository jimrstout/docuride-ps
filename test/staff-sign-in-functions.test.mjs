// The Edge Functions enforce the staff sign-in themselves.
//
// Details, Prepare presentation and the staff functions used to open from a
// bare link: the Next server forwarded every call with the webhook secret and
// checked nobody. Now the server forwards the staff sign-in cookie, and each
// staff Edge Function checks it against the deal's tenant and store itself.
//
// Three layers, each tested here:
//   1. The credential and the rule (_shared/staff-auth.ts), against a cookie
//      the Next side really mints.
//   2. The gate as the functions run it (_shared/staff-gate.ts), with a fake
//      database: what a refused request gets back, and what it never reads.
//   3. The functions' source: every staff function calls the gate before it
//      reads, and the CRM's own calls keep the webhook secret path.
// The screens' half is test/staff-sign-in-screens.test.mjs.
//
// Mock data only: made-up ids and emails, no real deal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mintConsoleCookie } from "../apps/ownership-planner/lib/console-cookie.ts";
import {
  decideStaff,
  staffMayOpen,
  verifyStaffToken,
  STAFF_HEADER,
} from "../supabase/functions/_shared/staff-auth.ts";

const SECRET = "a-webhook-secret-of-realistic-length-0123456789";
const NOW = Date.UTC(2026, 10, 2, 15, 0, 0);

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const STORE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "5e55e55e-5e55-4e55-8e55-5e55e55e5e55";

const ADMIN = { user_id: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a", tenant_id: null, store_ids: [], is_platform_admin: true };
const STAFF_A = { user_id: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", tenant_id: TENANT, store_ids: [STORE_A], is_platform_admin: false };
const NO_STORES = { user_id: "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c", tenant_id: TENANT, store_ids: [], is_platform_admin: false };

const cookieFor = (p, email = "test.person@example.com", now = NOW) =>
  mintConsoleCookie({ sub: p.user_id, email }, SECRET, now);

const fn = (name) => readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");

// ── 1. The credential and the rule ─────────────────────────────────────────

test("a cookie the Next side mints is accepted by the Edge Functions", async () => {
  const s = await verifyStaffToken(cookieFor(STAFF_A), SECRET, NOW);
  assert.equal(s?.sub, STAFF_A.user_id);
  assert.equal(s?.email, "test.person@example.com");
});

test("no cookie, a forged one, an edited one or an expired one is not a sign-in", async () => {
  assert.equal(await verifyStaffToken(null, SECRET, NOW), null);
  assert.equal(await verifyStaffToken("", SECRET, NOW), null);
  assert.equal(await verifyStaffToken("v1.abc.def", SECRET, NOW), null);
  const forged = mintConsoleCookie({ sub: ADMIN.user_id, email: "x@example.com" }, "another-secret-entirely-0000000000", NOW);
  assert.equal(await verifyStaffToken(forged, SECRET, NOW), null);
  const [v, , sig] = cookieFor(STAFF_A).split(".");
  const edited = Buffer.from(JSON.stringify({ sub: ADMIN.user_id, email: "x@example.com", exp: 9e9 })).toString("base64url");
  assert.equal(await verifyStaffToken(`${v}.${edited}.${sig}`, SECRET, NOW), null);
  const old = cookieFor(STAFF_A, "x@example.com", NOW - 13 * 3600 * 1000);
  assert.equal(await verifyStaffToken(old, SECRET, NOW), null);
  assert.equal(await verifyStaffToken(cookieFor(STAFF_A), null, NOW), null, "no secret configured refuses everyone");
});

test("the rule: a platform admin anywhere, staff only in their own tenant and listed store", () => {
  const deal = { tenant_id: TENANT, store_id: STORE_A };
  assert.equal(staffMayOpen(ADMIN, deal), true);
  assert.equal(staffMayOpen(STAFF_A, deal), true);
  assert.equal(staffMayOpen(STAFF_A, { tenant_id: TENANT, store_id: STORE_B }), false, "wrong store");
  assert.equal(staffMayOpen(STAFF_A, { tenant_id: OTHER_TENANT, store_id: STORE_A }), false, "wrong tenant");
  assert.equal(staffMayOpen(NO_STORES, deal), false, "no stores listed is no deals, never all");
  assert.equal(staffMayOpen(STAFF_A, { tenant_id: TENANT, store_id: null }), false, "a deal with no store is admins only");
  assert.equal(staffMayOpen(ADMIN, { tenant_id: null, store_id: null }), true);
});

function loaders(profiles, deal) {
  const reads = { profile: 0, deal: 0 };
  return {
    reads,
    profile: async (id) => { reads.profile++; return profiles.find((p) => p.user_id === id) ?? null; },
    deal: async () => { reads.deal++; return deal; },
  };
}

test("signed out: refused with 401, and the deal is never read", async () => {
  const l = loaders([ADMIN, STAFF_A], { tenant_id: TENANT, store_id: STORE_A });
  const d = await decideStaff({ token: null, secret: SECRET, now: NOW, profile: l.profile, deal: l.deal });
  assert.deepEqual([d.ok, d.status], [false, 401]);
  assert.equal(l.reads.deal, 0);
  assert.equal(l.reads.profile, 0);
});

test("signed in to the wrong store: refused with 403", async () => {
  const l = loaders([STAFF_A], { tenant_id: TENANT, store_id: STORE_B });
  const d = await decideStaff({ token: cookieFor(STAFF_A), secret: SECRET, now: NOW, profile: l.profile, deal: l.deal });
  assert.deepEqual([d.ok, d.status], [false, 403]);
  assert.doesNotMatch(d.error, /[0-9a-f]{8}-/, "the refusal names no deal or store");
});

test("signed in to the deal's store: allowed, and who it is comes back for the record", async () => {
  const l = loaders([STAFF_A], { tenant_id: TENANT, store_id: STORE_A });
  const d = await decideStaff({ token: cookieFor(STAFF_A), secret: SECRET, now: NOW, profile: l.profile, deal: l.deal });
  assert.equal(d.ok, true);
  assert.equal(d.staff.sub, STAFF_A.user_id);
});

test("a person whose profile was removed is signed out at once, cookie or not", async () => {
  const l = loaders([], { tenant_id: TENANT, store_id: STORE_A });
  const d = await decideStaff({ token: cookieFor(STAFF_A), secret: SECRET, now: NOW, profile: l.profile, deal: l.deal });
  assert.deepEqual([d.ok, d.status], [false, 401]);
});

test("an unknown deal looks like another store's to anyone but a platform admin", async () => {
  const staff = await decideStaff({ token: cookieFor(STAFF_A), secret: SECRET, now: NOW, ...loaders([STAFF_A], null) });
  assert.equal(staff.status, 403);
  const admin = await decideStaff({ token: cookieFor(ADMIN), secret: SECRET, now: NOW, ...loaders([ADMIN], null) });
  assert.equal(admin.status, 404);
});

test("the admin area's functions, which span every tenant, take a platform admin only", async () => {
  const staff = await decideStaff({ token: cookieFor(STAFF_A), secret: SECRET, now: NOW, profile: loaders([STAFF_A]).profile, deal: null });
  assert.deepEqual([staff.ok, staff.status], [false, 403]);
  const admin = await decideStaff({ token: cookieFor(ADMIN), secret: SECRET, now: NOW, profile: loaders([ADMIN]).profile, deal: null });
  assert.equal(admin.ok, true);
});

// ── 2. The gate as the functions run it ────────────────────────────────────

async function withFakeProject(rows, run) {
  const realFetch = globalThis.fetch;
  const hadDeno = "Deno" in globalThis;
  const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key", FNI_WEBHOOK_SECRET: SECRET };
  const asked = [];
  globalThis.Deno = { env: { get: (k) => env[k] } };
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    const body = u.includes("/profiles?") ? rows.profiles.filter((p) => u.includes(p.user_id))
      : u.includes("/sessions?") ? rows.sessions.filter((s) => u.includes(s.id)).map(({ tenant_id, store_id }) => ({ tenant_id, store_id }))
      : [];
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = realFetch;
    if (!hadDeno) delete globalThis.Deno;
  }
}

const { staffGate } = await import("../supabase/functions/_shared/staff-gate.ts");
const ROWS = {
  profiles: [ADMIN, STAFF_A],
  sessions: [{ id: SESSION, tenant_id: TENANT, store_id: STORE_A, buyer_name: "Mock Buyer", deal_number: "99999" }],
};
const request = (cookie) =>
  new Request("https://example.supabase.co/functions/v1/fni-session-get?session_id=" + SESSION, {
    headers: { "x-webhook-secret": SECRET, ...(cookie ? { [STAFF_HEADER]: cookie } : {}) },
  });

test("each staff function, signed out: 401, and the response carries no deal data", async () => {
  await withFakeProject(ROWS, async (asked) => {
    const res = await staffGate(request(null), SESSION);
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.deepEqual(Object.keys(JSON.parse(text)), ["error"]);
    assert.doesNotMatch(text, /99999|Mock Buyer|5e55e55e/);
    assert.equal(asked.length, 0, "nothing was read");
  });
});

test("each staff function, signed in to the wrong store: 403 with no deal data", async () => {
  const otherStore = { ...STAFF_A, store_ids: [STORE_B] };
  await withFakeProject({ ...ROWS, profiles: [otherStore] }, async () => {
    const res = await staffGate(request(cookieFor(otherStore)), SESSION);
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.deepEqual(Object.keys(JSON.parse(text)), ["error"]);
    assert.doesNotMatch(text, /99999|Mock Buyer/);
  });
});

test("each staff function, signed in to the deal's store: passes", async () => {
  await withFakeProject(ROWS, async () => {
    assert.equal(await staffGate(request(cookieFor(STAFF_A)), SESSION), null);
    assert.equal(await staffGate(request(cookieFor(ADMIN)), SESSION), null);
  });
});

test("a database that cannot be read refuses rather than lets through", async () => {
  const realFetch = globalThis.fetch;
  globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k", FNI_WEBHOOK_SECRET: SECRET })[k] } };
  globalThis.fetch = async () => new Response("down", { status: 500 });
  try {
    const res = await staffGate(request(cookieFor(STAFF_A)), SESSION);
    assert.equal(res.status, 503);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.Deno;
  }
});

// ── 3. Every staff function calls the gate before it reads ─────────────────

/** Functions that serve or change one deal's staff data. */
const DEAL_FUNCTIONS = [
  "fni-session-get", "fni-session-save", "fni-acknowledgment", "fni-session-verify",
  "fni-vin-decode", "fni-rate-vehicle", "fni-menu-prepare", "fni-contract-submit",
  "fni-contract-void", "fni-contract-documents", "fni-oem-contracts",
];
/** The admin area's functions: every tenant at once, platform admins only. */
const ADMIN_FUNCTIONS = ["fni-admin-sessions", "fni-admin-settings", "fni-price-sheets", "fni-price-sheet-parse"];
/** Called by the CRM or the scheduler, never with a staff sign-in. */
const NOT_STAFF = [
  "fni-session-start", "fni-documents-generated", "fni-admin-auth", "fni-health-check",
  "fni-refresh-rate-properties", "fni-refresh-vehicle-types", "zoho-sync", "zoho-backfill", "rr-report",
  // Started only by the database, with a one-time token (migration 0050).
  "fni-rate-probe",
];
/** One path each: by session_id for Details (gated), by CRM record for the CRM. */
const DUAL = ["fni-dx1-check", "fni-documents-to-deal-jacket"];

test("every function is accounted for, so a new one cannot skip the question", () => {
  const all = readdirSync(new URL("../supabase/functions/", import.meta.url)).filter((n) => !n.startsWith("_"));
  const known = new Set([...DEAL_FUNCTIONS, ...ADMIN_FUNCTIONS, ...NOT_STAFF, ...DUAL]);
  assert.deepEqual(all.filter((n) => !known.has(n)), []);
});

test("each deal function checks the sign-in for that deal before it reads anything", () => {
  for (const name of DEAL_FUNCTIONS) {
    const src = fn(name);
    const handler = src.slice(src.indexOf("serve("));
    const gate = handler.indexOf("await staffGate(req, ");
    assert.ok(gate > 0, `${name} calls the gate`);
    assert.doesNotMatch(handler.slice(gate, handler.indexOf(")", gate)), /null/, `${name} gates on its deal`);
    for (const read of [".from(", "loadSession(", "session(supabase", "list(supabase"]) {
      const at = handler.indexOf(read);
      if (at >= 0) assert.ok(gate < at, `${name}: the gate comes before ${read}`);
    }
    // After the secret, so a wrong secret is still the 401 the deploy smoke test expects.
    assert.ok(handler.indexOf("secretsMatch(") < gate, `${name}: secret first`);
  }
});

test("each admin function takes a platform admin, before it reads", () => {
  for (const name of ADMIN_FUNCTIONS) {
    const handler = fn(name).slice(fn(name).indexOf("serve("));
    const gate = handler.indexOf("await staffGate(req, null)");
    assert.ok(gate > 0, name);
    const read = handler.indexOf(".from(");
    if (read >= 0) assert.ok(gate < read, name);
  }
});

test("the CRM's own calls keep the webhook secret path: the launch button, Generate and filing", () => {
  for (const name of ["fni-session-start", "fni-documents-generated"]) {
    assert.doesNotMatch(fn(name), /staffGate/, name);
    assert.match(fn(name), /FNI_WEBHOOK_SECRET/, name);
  }
  const dx1 = fn("fni-dx1-check");
  assert.match(dx1, /if \(typeof body\.session_id === "string" && body\.session_id\.trim\(\) !== ""\) \{\n\s+const refused = await staffGate\(req, body\.session_id\.trim\(\)\);/);
  const jacket = fn("fni-documents-to-deal-jacket");
  assert.match(jacket, /if \(request\.session_id\) \{\n\s+const refused = await staffGate\(req, request\.session_id\);/);
});
