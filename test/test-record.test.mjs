// is_test comes from the DocuRide record's "Test Record Only" checkbox
// (API name Test_Record_Only) when a session starts, and is never cleared.
// is_test is what lets a session other than 13759 send contracts to the
// TecAssured QA server, so turning it off on a session with QA contracts
// behind it would be the dangerous direction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isTestRecord, mapSession, testRecordPatch } from "../supabase/functions/_shared/session-map.ts";

const base = { id: "4742556000999", Name: "13437" };
const session = (record) => mapSession(record, "store", "tenant", null, null, "Staff");

test("a ticked record starts a test session; anything else a real one", () => {
  assert.equal(session({ ...base, Test_Record_Only: true }).is_test, true);
  assert.equal(session({ ...base, Test_Record_Only: false }).is_test, false);
  assert.equal(session({ ...base }).is_test, false);
  assert.equal(session({ ...base, Test_Record_Only: "true" }).is_test, false);
  assert.equal(isTestRecord({ Test_Record_Only: null }), false);
});

test("reopening can make a session a test session, never the reverse", () => {
  assert.deepEqual(testRecordPatch({ Test_Record_Only: true }, { is_test: false }), { is_test: true });
  assert.deepEqual(testRecordPatch({ Test_Record_Only: true }, { is_test: true }), {});
  assert.deepEqual(testRecordPatch({ Test_Record_Only: false }, { is_test: true }), {});
  assert.deepEqual(testRecordPatch({}, { is_test: true }), {});
  assert.deepEqual(testRecordPatch({}, { is_test: false }), {});
});

test("session-start applies the patch on reopen", () => {
  const start = readFileSync(new URL("../supabase/functions/fni-session-start/index.ts", import.meta.url), "utf8");
  assert.match(start, /\.\.\.testRecordPatch\(record as unknown as Record<string, unknown>, session\)/);
  assert.doesNotMatch(start, /is_test:\s*false/);
});
