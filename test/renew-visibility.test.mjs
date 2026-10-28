// Renew for Today is offered when it would move a past date, not only when it
// would give the session longer (2026-10-28). A session already open to
// tonight with yesterday's sale date never showed the button, so PR 51's move
// to today could not be reached. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renewExtends, renewOffered } from "../supabase/functions/_shared/sale-date.ts";
import { storeToday } from "../supabase/functions/_shared/store-day.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const TODAY = "2026-10-28";
// 23:59:59 on 28 Oct in New York (EDT).
const TONIGHT = "2026-10-29T03:59:59+00:00";
const LAST_NIGHT = "2026-10-28T03:59:59+00:00";

const open = (sale, planned, over = {}) =>
  renewOffered({ expiresAt: TONIGHT, renewTo: TONIGHT, sale, planned, today: TODAY, ...over });

test("shown for a session open to tonight with yesterday's sale date", () => {
  assert.equal(open("2026-10-27", null), true);
});

test("shown when only the planned sale date is past", () => {
  assert.equal(open(TODAY, "2026-10-27"), true);
  assert.equal(open(null, "2026-10-27"), true);
});

test("hidden when the session runs to tonight and both dates are today or later", () => {
  assert.equal(open(TODAY, TODAY), false);
  assert.equal(open(TODAY, null), false);
  assert.equal(open("2026-10-29", "2026-10-29", { renewTo: "2026-10-30T03:59:59+00:00", expiresAt: "2026-10-30T03:59:59+00:00" }), false);
  assert.equal(open(null, null), false);
});

test("still shown whenever renewing would give the session longer", () => {
  assert.equal(open(TODAY, null, { expiresAt: LAST_NIGHT }), true);
  assert.equal(open(TODAY, null, { expiresAt: null }), true);
  assert.equal(renewExtends(LAST_NIGHT, TONIGHT), true);
  assert.equal(renewExtends(TONIGHT, TONIGHT), false);
  // Never shortened: an expiry later than tonight is not "extended".
  assert.equal(renewExtends("2026-10-29T09:00:00+00:00", TONIGHT), false);
  assert.equal(renewExtends(TONIGHT, null), false);
});

test("the store's time zone decides what today is", () => {
  // 03:00 UTC on 29 Oct: already tomorrow in UTC, still 28 Oct in Los Angeles.
  const now = new Date("2026-10-29T03:00:00Z");
  const today = storeToday("America/Los_Angeles", now);
  assert.equal(today, "2026-10-28");
  const laTonight = "2026-10-29T06:59:59+00:00"; // 23:59:59 PDT on 28 Oct
  const at = (sale) => renewOffered({ expiresAt: laTonight, renewTo: laTonight, sale, planned: null, today });
  assert.equal(at("2026-10-28"), false); // today at the store, though yesterday by UTC's date
  assert.equal(at("2026-10-27"), true);
  // The list takes today from Postgres, in the store's zone, with the target.
  const f = read("supabase/functions/fni-admin-sessions/index.ts");
  assert.match(f, /\.rpc\("session_renew_targets", \{ p_ids: sessionIds \}\)/);
  assert.match(f, /today: t\.store_today,/);
  assert.match(read("supabase/migrations/0038_store_time_zone_and_session_day.sql"), /returns table \(session_id uuid, renew_to timestamptz, store_today date, time_zone text\)/);
});

test("the list offers it by that rule, and never returns the staff layer", () => {
  const f = read("supabase/functions/fni-admin-sessions/index.ts");
  const list = f.slice(f.indexOf("async function list("), f.indexOf("async function renew("));
  assert.match(list, /return renewOffered\(\{\s*expiresAt:[\s\S]*?sale: saleDate\.get\(String\(s\.id\)\) \?\? null,\s*planned:[\s\S]*?today: t\.store_today,\s*\}\);/);
  // The sale date as it stands: a staff date where there is one.
  assert.match(list, /applyStaffEdits\(d, parseStaffEdits\(d\.staff_edits\)\)\.sale_date/);
  const output = list.slice(list.indexOf("sessions: sessions.map("));
  assert.doesNotMatch(output, /staff_edits|\bsale_date:/);
  assert.match(list, /renewable: renewable\(s\),/);
  // The one place it is offered reads that answer.
  const page = read("apps/ownership-planner/app/admin/sessions/page.tsx");
  assert.match(page, /\{row\.renewable \? \(\s*<form action=\{renewSession\}>/);
});

test("pressing it on a session already open to tonight moves dates and writes no renewal", () => {
  const f = read("supabase/functions/fni-admin-sessions/index.ts");
  const renew = f.slice(f.indexOf("async function renew("), f.indexOf("serve(async"));
  // The expiry is written only when that gives the session longer.
  assert.match(renew, /const extended = renewExtends\(before, renewTo\);\s*let next: string = before;\s*if \(extended\) \{\s*const \{ data: renewed, error: writeErr \} = await supabase\s*\.schema\("fni"\)\s*\.rpc\("renew_session", \{ p_session: sessionId \}\);/);
  assert.equal((renew.match(/\.rpc\("renew_session"/g) ?? []).length, 1);
  // Worked out after the dates move, so a planned date moved to today counts.
  assert.ok(renew.indexOf("renewDateMoves(") < renew.indexOf('rpc("session_renew_targets"'));
  // The only events are the date moves: no renewal event, so none to duplicate.
  assert.equal((renew.match(/\.from\("session_events"\)/g) ?? []).length, 1);
  assert.match(renew, /\.from\("session_events"\)\s*\.insert\(moves\.map\(\(m\) => \(\{/);
  // The answer says whether the open-until time changed.
  assert.match(renew, /extended,/);
  assert.match(renew, /revived: extended && /);
});
