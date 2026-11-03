// The provider login cache (speed part 2): only a login this instance made is
// sent. TecAssured refused logins sent from another Edge Function instance at
// 28, 51 and 67 seconds old, and accepted logins sent by the instance that
// made them up to over 2 minutes old (rate and probe logs, 2 and 3 Nov), so
// age does not decide it; the instance does. Mock values only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LOGIN_LIFETIME_MS, savedLoginFor } from "../supabase/functions/_shared/saved-login.ts";

const NOW = Date.UTC(2026, 10, 3, 18, 0, 0);
const madeAgo = (s) => new Date(NOW - s * 1000 + LOGIN_LIFETIME_MS).toISOString();
const none = { session_id_cached: null, session_expires_at: null };

test("a login this instance made is sent, with its age", () => {
  assert.deepEqual(savedLoginFor({ sessionId: "own", expiresAt: madeAgo(48) }, none, NOW), { from: "this instance", age_s: 48, used: true });
  // Kept for the usual 25 minutes, no longer.
  assert.equal(savedLoginFor({ sessionId: "own", expiresAt: madeAgo(24 * 60) }, none, NOW).used, true);
  assert.equal(savedLoginFor({ sessionId: "own", expiresAt: madeAgo(25 * 60 + 1) }, none, NOW).used, false);
});

test("a login another instance kept on the credential row is never sent, however young", () => {
  for (const age of [5, 28, 51, 67, 1100]) {
    const row = { session_id_cached: "theirs", session_expires_at: madeAgo(age) };
    assert.deepEqual(savedLoginFor(undefined, row, NOW), { from: "another instance", age_s: age, used: false }, String(age));
  }
  // This instance's own wins over the row.
  const row = { session_id_cached: "theirs", session_expires_at: madeAgo(10) };
  assert.equal(savedLoginFor({ sessionId: "own", expiresAt: madeAgo(90) }, row, NOW).from, "this instance");
  assert.deepEqual(savedLoginFor(undefined, none, NOW), { from: "none", age_s: null, used: false });
});

test("the client is built without another instance's login, so it logs in first; the refuse-and-retry stays", () => {
  const src = readFileSync(new URL("../supabase/functions/_shared/tecassured.ts", import.meta.url), "utf8");
  assert.match(src, /const saved = savedLoginFor\(shared, cred\);/);
  assert.match(src, /const withShared: TecAssuredCredentials = saved\.from === "this instance"\s*\? \{ \.\.\.cred, session_id_cached: shared!\.sessionId, session_expires_at: shared!\.expiresAt \}\s*: \{ \.\.\.cred, session_id_cached: null, session_expires_at: null \};/);
  assert.match(src, /await this\.invalidateSession\(\);\s*await this\.authenticate\(\);\s*const retryRes = await send\(\);/);
  // The facts carry who made the saved login, its age, whether it was sent, and whether the provider refused it.
  const adapter = readFileSync(new URL("../supabase/functions/_shared/adapters/tecassured.ts", import.meta.url), "utf8");
  for (const f of ["saved_login_from", "saved_login_age_s", "saved_login_used", "provider_login", "provider_login_retried"]) {
    assert.match(adapter, new RegExp(`timing\\.note\\("${f}"`), f);
  }
});
