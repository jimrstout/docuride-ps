// The session mode vocabulary.
//
// These strings are a CHECK constraint on fni.sessions and they also reach a
// buyer, because the acknowledgment document states which mode the session ran
// in. Both reasons to pin them down.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_MODES,
  isSessionMode,
  modeLabel,
} from "../supabase/functions/_shared/session-mode.ts";

test("the vocabulary matches the CHECK constraint on fni.sessions", () => {
  assert.deepEqual([...SESSION_MODES], [
    "Self-Guided",
    "Collaborative",
    "Staff-Presented",
  ]);
});

test("title case, like every other constrained column on the table", () => {
  for (const mode of SESSION_MODES) {
    assert.match(mode, /^[A-Z]/, `${mode} should start with a capital`);
    assert.notEqual(mode, mode.toLowerCase(), `${mode} should not be lowercase`);
  }
});

test("the old lowercase values are rejected, not quietly accepted", () => {
  for (const old of ["self-guided", "collaborative", "staff-presented"]) {
    assert.equal(isSessionMode(old), false, `${old} should no longer validate`);
  }
  for (const junk of [null, undefined, "", "Self Guided", "SELF-GUIDED", 7, {}]) {
    assert.equal(isSessionMode(junk), false);
  }
  for (const mode of SESSION_MODES) assert.equal(isSessionMode(mode), true);
});

test("every mode names itself on the acknowledgment", () => {
  assert.equal(modeLabel("Staff-Presented"), "Presented by dealership staff");
  assert.equal(modeLabel("Collaborative"), "Presented with dealership staff");
  assert.equal(modeLabel("Self-Guided"), "Self-guided");

  // A Collaborative session used to print "Self-guided", because the label was
  // a two-way check on Staff-Presented. That is a false statement on a document
  // somebody signs.
  assert.notEqual(modeLabel("Collaborative"), modeLabel("Self-Guided"));

  // A session nobody marked is one nobody was driving.
  assert.equal(modeLabel(null), "Self-guided");
  assert.equal(modeLabel(undefined), "Self-guided");
});
