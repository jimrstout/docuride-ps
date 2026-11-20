// The one DocuRide sign-in, as PS reads it.
//
// HQ, FX, DC and R&R keep the person's Supabase session in a docuride.com
// cookie (docuride-hq app/lib/shared-session.ts: base64url JSON in numbered
// pieces). PS reads it on the way in, has fni-admin-auth check it, and signs
// the person in to the console without a second password.
//
// Mock data only: made-up ids and tokens.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SHARED_KEY,
  clearSharedCookies,
  readSharedSession,
  refreshSharedSession,
  sharedCookieDomain,
  sharedSessionCookies,
  sharedTokenExpired,
} from "../apps/ownership-planner/lib/shared-sign-in.ts";

const NOW = Date.UTC(2026, 10, 19, 23, 0, 0);
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// What HQ's shared-session.ts writes: UTF-8 JSON, base64url, 3500-character pieces.
function hqCookies(session) {
  const data = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const jar = new Map();
  for (let i = 0; i * 3500 < data.length; i++) jar.set(`${SHARED_KEY}.${i}`, data.slice(i * 3500, (i + 1) * 3500));
  return jar;
}

const SESSION = { access_token: "a".repeat(900), refresh_token: "r1", expires_at: NOW / 1000 + 3600, user: { id: "u1", email: "test.person@example.com" } };

test("PS reads the session HQ wrote, including one split across pieces", () => {
  const jar = hqCookies({ ...SESSION, user: { ...SESSION.user, blob: "z".repeat(9000) } });
  assert.ok(jar.size > 1);
  const s = readSharedSession((n) => jar.get(n));
  assert.equal(s.refresh_token, "r1");
  assert.equal(s.user.blob.length, 9000);
});

test("no cookie, a damaged one, or one without tokens is no shared sign-in", () => {
  assert.equal(readSharedSession(() => undefined), null);
  assert.equal(readSharedSession((n) => (n === `${SHARED_KEY}.0` ? "%%%" : undefined)), null);
  const jar = hqCookies({ access_token: "", refresh_token: "r" });
  assert.equal(readSharedSession((n) => jar.get(n)), null);
});

test("an access token that has run out, or will within a minute, is refreshed first", () => {
  assert.equal(sharedTokenExpired({ ...SESSION, expires_at: NOW / 1000 + 3600 }, NOW), false);
  assert.equal(sharedTokenExpired({ ...SESSION, expires_at: NOW / 1000 + 30 }, NOW), true);
  assert.equal(sharedTokenExpired({ ...SESSION, expires_at: NOW / 1000 - 10 }, NOW), true);
});

test("a refreshed session is written back in HQ's format, on docuride.com, readable by the other apps' pages", () => {
  const writes = sharedSessionCookies(SESSION, "ps.docuride.com", [`${SHARED_KEY}.0`, `${SHARED_KEY}.1`, `${SHARED_KEY}.2`]);
  const jar = new Map(writes.filter((w) => w.options.maxAge > 0).map((w) => [w.name, w.value]));
  assert.deepEqual(readSharedSession((n) => jar.get(n)), SESSION);
  for (const w of writes) {
    assert.equal(w.options.domain, "docuride.com");
    assert.equal(w.options.httpOnly, false);
    assert.equal(w.options.secure, true);
    assert.equal(w.options.sameSite, "lax");
  }
  // Leftover pieces of a longer session are removed.
  assert.ok(writes.some((w) => w.name === `${SHARED_KEY}.2` && w.options.maxAge === 0));
});

test("the shared cookie is on docuride.com only when PS is", () => {
  assert.equal(sharedCookieDomain("ps.docuride.com"), "docuride.com");
  assert.equal(sharedCookieDomain("ps.docuride.com:443"), "docuride.com");
  assert.equal(sharedCookieDomain("docuride-ps.vercel.app"), undefined);
  assert.equal(sharedCookieDomain("evil-docuride.com"), undefined);
  assert.equal(sharedCookieDomain(null), undefined);
});

test("signing out of PS removes every piece of the shared sign-in, and nothing else", () => {
  const out = clearSharedCookies([`${SHARED_KEY}.0`, `${SHARED_KEY}.1`, "docuride_console", "other"], "ps.docuride.com");
  assert.deepEqual(out.map((w) => w.name), [`${SHARED_KEY}.0`, `${SHARED_KEY}.1`]);
  assert.ok(out.every((w) => w.options.maxAge === 0 && w.options.domain === "docuride.com"));
});

test("refresh: Supabase's answer becomes the new shared session; a refused refresh is null", async () => {
  const calls = [];
  const ok = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ access_token: "a2", refresh_token: "r2", expires_in: 3600, user: { id: "u1" } }) };
  };
  const s = await refreshSharedSession("https://example.supabase.co/", SESSION, ok, NOW);
  assert.equal(s.access_token, "a2");
  assert.equal(s.refresh_token, "r2");
  assert.equal(s.expires_at, NOW / 1000 + 3600);
  assert.equal(s.user.id, "u1");
  assert.equal(calls[0].url, "https://example.supabase.co/auth/v1/token?grant_type=refresh_token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { refresh_token: "r1" });
  assert.equal(await refreshSharedSession("https://x", SESSION, async () => ({ ok: false, json: async () => ({}) }), NOW), null);
  assert.equal(await refreshSharedSession("https://x", SESSION, async () => { throw new Error("offline"); }, NOW), null);
});

test("the sign-in form uses the shared sign-in only when it isn't showing a notice, so it cannot loop", () => {
  const form = read("apps/ownership-planner/components/admin/SignIn.tsx");
  assert.match(form, /if \(!notice && readSharedSession\(/);
  assert.match(form, /redirect\(`\/api\/sso\?next=\$\{encodeURIComponent\(next\)\}`\)/);
  const route = read("apps/ownership-planner/app/api/sso/route.ts");
  // Every failure goes back with a notice the form knows.
  for (const key of ["expired", "nosso", "slow", "broken"]) {
    assert.match(route, new RegExp(`withNotice\\(next, "${key}"\\)`));
    assert.match(form, new RegExp(`\\b${key}: "`));
  }
  assert.match(route, /safeStaffPath\(req\.nextUrl\.searchParams\.get\("next"\)\)/);
});

test("fni-admin-auth checks a shared token with Supabase Auth, applies the same rule, and never retires that session", () => {
  const fn = read("supabase/functions/fni-admin-auth/index.ts");
  const shared = fn.slice(fn.indexOf("if (sharedToken) {"), fn.indexOf("} else {"));
  assert.match(shared, /\/auth\/v1\/user/);
  assert.match(shared, /Authorization: `Bearer \$\{sharedToken\}`/);
  assert.doesNotMatch(shared, /logout/);
  assert.match(shared, /if \(!who\.ok\) return json\(401, DENIED\);/);
});

// ── One sign-in, both ways ──────────────────────────────────────────────────

import { liveConsoleCookie } from "../apps/ownership-planner/lib/admin-session-rules.ts";
import { mintConsoleCookie, CONSOLE_COOKIE } from "../apps/ownership-planner/lib/console-cookie.ts";
import { sharedUserId } from "../apps/ownership-planner/lib/shared-sign-in.ts";

const SECRET = "a-webhook-secret-of-realistic-length-0123456789";
const jarWith = (consoleFor, sharedSession) => {
  const jar = sharedSession ? hqCookies(sharedSession) : new Map();
  if (consoleFor) jar.set(CONSOLE_COOKIE, mintConsoleCookie({ sub: consoleFor, email: "test.person@example.com" }, SECRET, NOW));
  return (n) => jar.get(n);
};

test("the console counts while the shared sign-in is there and is the same person", () => {
  assert.ok(liveConsoleCookie(jarWith("u1", SESSION), SECRET, NOW));
});

test("signed out in another app (shared sign-in gone): signed out of PS too", () => {
  assert.equal(liveConsoleCookie(jarWith("u1", null), SECRET, NOW), null);
});

test("someone else signed in on this computer: the last person's console doesn't count", () => {
  assert.equal(liveConsoleCookie(jarWith("u1", { ...SESSION, user: { id: "u2" } }), SECRET, NOW), null);
});

test("no console cookie, or a forged one, still isn't a sign-in", () => {
  assert.equal(liveConsoleCookie(jarWith(null, SESSION), SECRET, NOW), null);
  const forged = jarWith("u1", SESSION);
  assert.equal(liveConsoleCookie((n) => (n === CONSOLE_COOKIE ? "v1.abc.def" : forged(n)), SECRET, NOW), null);
});

test("whose shared session: the stored user, else the access token's subject", () => {
  assert.equal(sharedUserId(SESSION), "u1");
  const tok = `x.${Buffer.from(JSON.stringify({ sub: "u9" })).toString("base64url")}.y`;
  assert.equal(sharedUserId({ access_token: tok, refresh_token: "r", expires_at: 0 }), "u9");
  assert.equal(sharedUserId({ access_token: "nope", refresh_token: "r", expires_at: 0 }), null);
});

test("signing in on the PS form shares the session with every app; a manager's approval does not", () => {
  const edge = read("apps/ownership-planner/lib/edge.ts");
  assert.match(edge, /adminSignIn: <T>\(email: string, password: string\) =>\s*call<T>\("fni-admin-auth", \{ method: "POST", body: \{ email, password, share: true \} \}\)/);
  const actions = read("apps/ownership-planner/app/console-actions.ts");
  assert.match(actions, /edge\.adminSignIn</);
  assert.match(actions, /sharedSessionCookies\(user\.session, host,/);
  assert.doesNotMatch(read("apps/ownership-planner/app/prepare/[sessionId]/actions.ts"), /adminSignIn/);
  // The page gate and the staff header both use the same rule.
  assert.match(read("apps/ownership-planner/lib/admin-session.ts"), /liveConsoleCookie\(/);
  assert.match(edge, /return liveConsoleCookie\(\(name\) => jar\.get\(name\)\?\.value\);/);
});

test("fni-admin-auth returns the session only when asked and admitted; otherwise it is retired", () => {
  const fn = read("supabase/functions/fni-admin-auth/index.ts");
  assert.match(fn, /const share = body\.share === true;/);
  assert.match(fn, /if \(share && granted && typeof granted\.refresh_token === "string"\) \{\s*return \{ user_id: userId, email: userEmail \?\? email, session: granted \};\s*\}\s*await retire\(\);/);
  // Every refusal after the grant retires it.
  assert.equal((fn.match(/return refuse\(/g) ?? []).length, 3);
  assert.doesNotMatch(fn, /return json\(401, DENIED\);\s*\}\s*\n\s*return json\(200/);
});
