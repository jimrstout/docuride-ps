// Every recorded action on Details credits the signed-in person.
//
// The Checked by box asked whoever was at the desk to type a name, and the
// verification, each edit and each contract-party change carried whatever was
// typed. Now that Details is signed in, fni-session-verify takes the person
// from the staff sign-in it checked, never from the page: their initials go on
// the verification ("Verified by JS"), on each staff edit, and on a session
// event for each action. Nothing is dropped: sessions verified under a typed
// name keep it, and Details still shows it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { staffInitials } from "../supabase/functions/_shared/staff-auth.ts";
import { initialsFor } from "../apps/ownership-planner/lib/admin-sections.ts";
import {
  recordStaffEvent,
  SHEET_SAVED_EVENT,
  VERIFIED_EVENT,
} from "../supabase/functions/_shared/staff-events.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const verifyFn = read("supabase/functions/fni-session-verify/index.ts");
const post = verifyFn.slice(verifyFn.indexOf('if (req.method !== "POST") return json(405'));

test("the initials are the same whichever side works them out", () => {
  for (const email of ["jim.stout@example.com", "jim@example.com", "j@example.com", "mary-ann_lee@example.com", "x+y@example.com", "@example.com"]) {
    assert.equal(staffInitials(email), initialsFor(email), email);
  }
  assert.equal(staffInitials("test.person@example.com"), "TP");
});

test("rating, saves and contract-party edits credit the signed-in person, not a typed name", () => {
  assert.match(post, /const checked = await staffCheck\(req, sessionId\);\s*if \("response" in checked\) return checked\.response;\s*const who = staffInitials\(checked\.staff\.email\);/);
  // Nothing posted can choose the name any more.
  assert.doesNotMatch(post, /body\.verified_by|body\.edited_by/);
  assert.match(post, /await verify\(supabase, s, who\)/);
  assert.match(post, /await save\(supabase, s, entries as Record<string, unknown>, who\)/);
  assert.match(post, /await partyAction\(supabase, s, action, body, who\)/);
});

test("each action that worked leaves a session event with the initials", () => {
  assert.match(post, /if \(res\.ok\) await recordStaffEvent\(supabase, sessionId, event, who, detail\);/);
  for (const ev of ["SHEET_SAVED_EVENT", "REFRESHED_EVENT", "PARTIES_CHANGED_EVENT", "EDITS_DISCARDED_EVENT", "MENU_LEVELS_EVENT", "VERIFIED_EVENT"]) {
    assert.match(post, new RegExp(`credited\\([\\s\\S]*?${ev}`), ev);
  }
});

test("the event says what changed and who, never a value", async () => {
  const rows = [];
  const fake = { schema: () => ({ from: (t) => ({ insert: async (row) => { rows.push({ t, ...row }); return { error: null }; } }) }) };
  await recordStaffEvent(fake, "5e55e55e-5e55-4e55-8e55-5e55e55e5e55", SHEET_SAVED_EVENT, "TP", { fields: ["engine.ccs"] });
  await recordStaffEvent(fake, "5e55e55e-5e55-4e55-8e55-5e55e55e5e55", VERIFIED_EVENT, "TP");
  assert.deepEqual(rows[0], { t: "session_events", session_id: "5e55e55e-5e55-4e55-8e55-5e55e55e5e55", event: "Deal sheet changed", detail: { fields: ["engine.ccs"] }, created_by: "TP" });
  assert.equal(rows[1].event, "Verified for rating");
  assert.equal(rows[1].created_by, "TP");
  // The save event carries field keys only.
  assert.match(post, /SHEET_SAVED_EVENT,\s*\{ fields: Object\.keys\(entries as Record<string, unknown>\) \},/);
});

test("a failed event write never undoes the action", async () => {
  const fake = { schema: () => ({ from: () => ({ insert: async () => ({ error: { message: "down" } }) }) }) };
  const quiet = console.error;
  console.error = () => {};
  try {
    await recordStaffEvent(fake, "s", VERIFIED_EVENT, "TP");
  } finally {
    console.error = quiet;
  }
});

test("old sessions keep their Checked by names: nothing is dropped or rewritten", () => {
  // The sheet returns verified_by exactly as stored, a typed name or initials.
  assert.match(verifyFn, /verified_by: s\.verified_by \?\? null,/);
  // No migration touches the column, and none drops anything.
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(sql, /drop column[^;]*verified_by/i, f);
  }
});
