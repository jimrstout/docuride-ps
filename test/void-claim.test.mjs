// A second Void of the same contract, a moment after the first (a double
// click, two tabs), is refused before it reaches TecAssured.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alreadyVoidingMessage, unclaimedFilter, VOID_CLAIM_STALE_MS } from "../supabase/functions/_shared/void-claim.ts";

const fn = readFileSync(new URL("../supabase/functions/fni-contract-void/index.ts", import.meta.url), "utf8");

test("a claim is free when nobody holds it, or when it is three minutes stale", () => {
  assert.equal(VOID_CLAIM_STALE_MS, 180_000);
  assert.equal(unclaimedFilter(new Date("2026-10-27T12:00:00.000Z")), "void_started_at.is.null,void_started_at.lt.2026-10-27T11:57:00.000Z");
});

test("the second request is told plainly, and nothing more is sent", () => {
  assert.equal(
    alreadyVoidingMessage("Battery Plus (PPM-1)"),
    "Battery Plus (PPM-1) is already being voided. Wait a moment, then reload the page to see the result. Nothing more was sent to TecAssured."
  );
  assert.doesNotMatch(alreadyVoidingMessage("x"), /—/);
});

test("the row is claimed atomically before TecAssured is called, and only one request gets it", () => {
  const claim = fn.indexOf('.update({ void_started_at: new Date().toISOString() })');
  const call = fn.indexOf("await client.voidContract(");
  assert.ok(claim > 0 && claim < call);
  const stmt = fn.slice(claim, fn.indexOf(".maybeSingle();", claim));
  assert.match(stmt, /\.eq\("id", row\.id\)/);
  assert.match(stmt, /\.neq\("status", "Voided"\)/);
  assert.match(stmt, /\.or\(unclaimedFilter\(new Date\(\)\)\)/);
  assert.match(fn, /if \(!claimed\) \{\s*return json\(409, \{ error: alreadyVoidingMessage\(describeContract\(row\)\)/);
});

test("the claim is let go whatever happens", () => {
  // Refused by TecAssured, recorded as Voided, failed to record, or thrown.
  assert.match(fn, /if \(err\) \{\s*await releaseClaim\(\);/);
  assert.match(fn, /void_reason: reason,\s*\/\/ The void is done: the claim goes with it\.\s*void_started_at: null,/);
  assert.match(fn, /Voided at TecAssured but not recorded[^\n]*\n\s*await releaseClaim\(\);/);
  assert.match(fn, /\/\/ A void that stopped part way leaves nothing claimed\.\s*await releaseClaim\(\);/);
});

test("the migration only adds the column", () => {
  const sql = readFileSync(new URL("../supabase/migrations/0037_contract_void_claim.sql", import.meta.url), "utf8");
  assert.match(sql, /alter table fni\.agreement_products add column if not exists void_started_at timestamptz;/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\bdrop\b|\bdelete\b|\bupdate\b/i);
});
