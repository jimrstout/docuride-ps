// The payment math exists in two runtimes: Deno renders the acknowledgment
// document with it, and the browser recomputes payments with it as the customer
// changes their mind. Two copies that disagree would put a different number on
// the screen than on the signed document, so this fails the build if they drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const EDGE = "supabase/functions/_shared/money.ts";
const APP = "apps/ownership-planner/lib/money.ts";

function sharedBlock(path) {
  const src = readFileSync(path, "utf8");
  const start = src.indexOf("// ─── SHARED BLOCK START");
  const end = src.indexOf("// ─── SHARED BLOCK END");
  assert.ok(start !== -1, `${path} is missing its SHARED BLOCK START marker`);
  assert.ok(end > start, `${path} is missing its SHARED BLOCK END marker`);
  return src.slice(start, end);
}

test("the Deno and browser copies of the payment math are identical", () => {
  assert.equal(
    sharedBlock(EDGE),
    sharedBlock(APP),
    "supabase/functions/_shared/money.ts and apps/ownership-planner/lib/money.ts have drifted"
  );
});
