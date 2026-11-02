// The shared secret: the x-webhook-secret header first, the ?secret= address
// form still accepted for now (docs/secrets-in-web-addresses.md).
//
// Eight functions read the address first, so a caller moving to the header
// with an old ?secret= still in its address would have been refused. Every
// function that takes the shared secret now reads it through one helper.
// Turning the address form off, and replacing the secrets it exposed, wait for
// Jim. Made-up values only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { presentedSecret, secretForm } from "../supabase/functions/_shared/presented-secret.ts";

/** The same compare _shared/supabase.ts makes, copied because that module needs Deno. */
function secretsMatch(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const BASE = "https://example.supabase.co/functions/v1/zoho-sync";
const req = (query, header) =>
  new Request(`${BASE}${query}`, { method: "POST", headers: header === undefined ? {} : { "x-webhook-secret": header } });

test("the header wins, even over a stale value in the address", () => {
  assert.equal(presentedSecret(req("?secret=old-value", "new-value")), "new-value");
  assert.equal(secretForm(req("?secret=old-value", "new-value")), "header");
  assert.equal(secretsMatch(presentedSecret(req("?secret=old-value", "new-value")), "new-value"), true);
});

test("the address form still works while the CRM moves over", () => {
  assert.equal(presentedSecret(req("?secret=made-up", undefined)), "made-up");
  assert.equal(secretForm(req("?secret=made-up&mode=drain", undefined)), "address");
  // An empty header is no header.
  assert.equal(presentedSecret(req("?secret=made-up", "")), "made-up");
});

test("no secret at all is refused", () => {
  assert.equal(presentedSecret(req("", undefined)), null);
  assert.equal(secretForm(req("", undefined)), "none");
  assert.equal(secretsMatch(presentedSecret(req("", undefined)), "made-up"), false);
});

test("every function that takes the shared secret reads it through the helper", () => {
  const FUNCTIONS = [
    "zoho-sync", "fni-session-start", "fni-documents-generated", "fni-dx1-check", "fni-documents-to-deal-jacket",
    "fni-session-get", "fni-session-save", "fni-session-verify", "fni-rate-vehicle", "fni-vin-decode",
    "fni-acknowledgment", "fni-contract-submit", "fni-contract-void", "fni-contract-documents", "fni-menu-prepare",
    "fni-admin-auth", "fni-admin-sessions", "fni-admin-settings",
  ];
  for (const name of FUNCTIONS) {
    const src = readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");
    assert.match(src, /presentedSecret\(req\)/, name);
    assert.doesNotMatch(src, /searchParams\.get\("secret"\)/, name);
  }
  // The log line says which form, never the value.
  const sync = readFileSync(new URL("../supabase/functions/zoho-sync/index.ts", import.meta.url), "utf8");
  assert.match(sync, /presentedVia: secretForm\(req\),/);
});
