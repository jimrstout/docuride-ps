// Renew for Today also moves past dates to today (2026-10-28). A sale date or
// planned sale date before today at the store moves to today as a staff edit,
// each move is a session event naming who did it, and a moved sale date makes
// the rating out of date so Submit needs a re-rate. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dateMoveEvent,
  keepStaffSaleDate,
  movedSaleDateEdit,
  RATING_OUT_OF_DATE,
  renewDateMoves,
  renewedBy,
  saleDateChoice,
  staleRatingProblem,
  SYSTEM,
} from "../supabase/functions/_shared/sale-date.ts";
import { storeToday } from "../supabase/functions/_shared/store-day.ts";
import { applyStaffEdits, parseStaffEdits } from "../supabase/functions/_shared/staff-edits.ts";
import { crmRatingFields } from "../supabase/functions/_shared/crm-fields.ts";
import { editFor } from "../supabase/functions/fni-session-verify/save-edits.ts";
import { initialsFor } from "../apps/ownership-planner/lib/admin-sections.ts";
import * as planner from "../apps/ownership-planner/lib/submit-check.ts";
import { flashMessage } from "../apps/ownership-planner/lib/verify-flash.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const TODAY = "2026-10-28";
const SALE = { kind: "column", column: "sale_date", cast: "date" };

test("a sale date and planned sale date before today move to today", () => {
  assert.deepEqual(renewDateMoves({ sale: "2026-10-27", planned: "2026-10-26", today: TODAY }), [
    { field: "sale_date", label: "Sale date", from: "2026-10-27", to: TODAY },
    { field: "planned_sale_date", label: "Planned sale date", from: "2026-10-26", to: TODAY },
  ]);
});

test("today and future dates are left alone, so a deal prepared for tomorrow keeps tomorrow", () => {
  assert.deepEqual(renewDateMoves({ sale: TODAY, planned: TODAY, today: TODAY }), []);
  assert.deepEqual(renewDateMoves({ sale: "2026-10-29", planned: "2026-10-29", today: TODAY }), []);
  // Only the one in the past moves.
  assert.deepEqual(
    renewDateMoves({ sale: "2026-10-27", planned: "2026-10-29", today: TODAY }).map((m) => m.field),
    ["sale_date"]
  );
});

test("an empty planned sale date stays empty, and a missing sale date stays missing", () => {
  assert.deepEqual(renewDateMoves({ sale: "2026-10-27", planned: null, today: TODAY }).map((m) => m.field), ["sale_date"]);
  assert.deepEqual(renewDateMoves({ sale: null, planned: null, today: TODAY }), []);
  assert.deepEqual(renewDateMoves({ sale: "", planned: "", today: TODAY }), []);
});

test("the store's time zone decides what today is", () => {
  // 03:00 UTC on 29 Oct is already tomorrow in UTC, and still 28 Oct (8 PM) in Los Angeles.
  const now = new Date("2026-10-29T03:00:00Z");
  const today = storeToday("America/Los_Angeles", now);
  assert.equal(today, "2026-10-28");
  assert.equal(storeToday("America/New_York", now), "2026-10-28");
  assert.equal(new Date(now).toISOString().slice(0, 10), "2026-10-29");
  // A deal sold today at the store is not moved to the UTC day.
  assert.deepEqual(renewDateMoves({ sale: "2026-10-28", planned: "2026-10-28", today }), []);
  // Yesterday at the store moves to today at the store, not to the UTC day.
  assert.deepEqual(renewDateMoves({ sale: "2026-10-27", planned: null, today }).map((m) => m.to), ["2026-10-28"]);
  // The renew asks for today in the store's own zone.
  const f = read("supabase/functions/fni-admin-sessions/index.ts");
  assert.match(f, /\.from\("stores"\)\s*\.select\("time_zone"\)\s*\.eq\("id", s\.store_id as string\)/);
  assert.match(f, /const today = storeToday\(\(storeRow as \{ time_zone\?: string \} \| null\)\?\.time_zone \?\? null\);/);
});

test("the event names the signed-in person's initials, or System when nobody is signed in", () => {
  const move = { field: "sale_date", label: "Sale date", from: "2026-10-27", to: TODAY };
  assert.equal(dateMoveEvent(move, renewedBy("JS")), "Sale date moved from 27 Oct 2026 to 28 Oct 2026 by JS");
  assert.equal(dateMoveEvent(move, renewedBy(undefined)), "Sale date moved from 27 Oct 2026 to 28 Oct 2026 by System");
  assert.equal(
    dateMoveEvent({ ...move, field: "planned_sale_date", label: "Planned sale date" }, "AB"),
    "Planned sale date moved from 27 Oct 2026 to 28 Oct 2026 by AB"
  );
  assert.equal(SYSTEM, "System");
  // Only initials reach the record. A name or an email is not initials.
  assert.equal(renewedBy("js"), "JS");
  assert.equal(renewedBy(""), SYSTEM);
  assert.equal(renewedBy("Sample Staff"), SYSTEM);
  assert.equal(renewedBy("ops@docuride.test"), SYSTEM);
  // The initials are the signed-in person's, as their admin avatar shows them.
  assert.equal(initialsFor("sample.staff@docuride.test"), "SS");
  const actions = read("apps/ownership-planner/app/console-actions.ts");
  const renew = actions.slice(actions.indexOf("export async function renewSession"), actions.indexOf("revalidatePath(SESSIONS);\n  redirect(SESSIONS);"));
  assert.match(renew, /edge\.adminRenew<\{ expires_at: string \}>\(sessionId, initialsFor\(operator\.email\)\)/);
  // Never the Checked by field.
  assert.doesNotMatch(renew, /checker/i);
  const f = read("supabase/functions/fni-admin-sessions/index.ts");
  assert.match(f, /const who = renewedBy\(body\.renewed_by\);/);
  assert.match(f, /event: dateMoveEvent\(m, who\),/);
  assert.match(f, /created_by: who,/);
  assert.match(f, /\.from\("session_events"\)\s*\.insert\(moves\.map/);
});

test("the moved sale date is a staff edit that Refresh from CRM never overwrites", () => {
  const edit = movedSaleDateEdit("2026-10-27", TODAY, "JS", "2026-10-28T14:00:00Z");
  assert.deepEqual(edit, {
    value: TODAY, original: "2026-10-27", original_source: "CRM", edited_by: "JS", edited_at: "2026-10-28T14:00:00Z",
  });
  const edits = parseStaffEdits({ sale_date: edit });
  // Refresh writes the CRM's columns only, never staff_edits.
  const patch = crmRatingFields({ Sale_Date: "2026-10-27", Condition: "Used" });
  assert.equal(patch.sale_date, "2026-10-27");
  assert.ok(!("staff_edits" in patch));
  const refreshed = { sale_date: patch.sale_date, staff_edits: edits };
  assert.equal(applyStaffEdits(refreshed, edits).sale_date, TODAY);
  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /const patch = crmRatingFields\(record as unknown as Record<string, unknown>\);/);
  // A sheet save posts the date back unchanged; that keeps the edit as it was.
  assert.equal(editFor(SALE, TODAY, { value: "2026-10-27", source: "CRM" }, edit, "Someone Else", "later"), edit);
});

test("Details shows CRM now says, with Keep staff value and Use CRM value, while they differ", () => {
  const edit = movedSaleDateEdit("2026-10-27", TODAY, "JS", "2026-10-28T14:00:00Z");
  const edits = { sale_date: edit };
  assert.deepEqual(saleDateChoice({ sale_date: "2026-10-27" }, edits), {
    staff_value: TODAY, crm_value: "2026-10-27", edited_by: "JS", edited_at: "2026-10-28T14:00:00Z",
  });
  // The CRM catches up: nothing to choose.
  assert.equal(saleDateChoice({ sale_date: TODAY }, edits), null);
  // Kept over that CRM date: not asked again ...
  const kept = parseStaffEdits({ sale_date: keepStaffSaleDate(edit, "2026-10-27", "Sample Staff", "t") });
  assert.equal(kept.sale_date.crm_kept, "2026-10-27");
  assert.equal(kept.sale_date.value, TODAY);
  assert.equal(saleDateChoice({ sale_date: "2026-10-27" }, kept), null);
  // ... until the CRM says something new.
  assert.equal(saleDateChoice({ sale_date: "2026-10-30" }, kept).crm_value, "2026-10-30");
  // No staff date, no choice.
  assert.equal(saleDateChoice({ sale_date: "2026-10-27" }, {}), null);

  const page = read("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(page, /\{sheet\.sale_date_choice \? \(/);
  assert.match(page, /CRM now says\{" "\}\s*<strong>\{dayLabel\(sheet\.sale_date_choice\.crm_value\)\}<\/strong>/);
  assert.match(page, /<form action=\{keepStaffSaleDate\}>/);
  assert.match(page, /<PendingButton pending="Keeping\.\.\.">Keep staff value<\/PendingButton>/);
  assert.match(page, /<form action=\{useCrmSaleDate\}>/);
  assert.match(page, /<PendingButton pending="Switching\.\.\.">Use CRM value<\/PendingButton>/);
  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /sale_date_choice: saleDateChoice\(s, edits\),/);
  assert.match(verify, /if \(action === "sale_date_use_crm"\) delete edits\.sale_date;/);
  // Using the CRM's date is a rating input change, handled as any other.
  assert.match(verify, /async function saleDateAction[\s\S]*?const changed = await unverifyIfInputsMoved\(supabase, fresh\);/);
  assert.equal(flashMessage({ code: "saledatekept", detail: null }).text, "Kept the staff sale date.");
  assert.equal(flashMessage({ code: "saledatecrm", detail: null }).text, "Now using the CRM sale date.");
});

test("a sale date moved into another month makes the rating out of date, and Submit then needs a re-rate", () => {
  assert.equal(staleRatingProblem({ out_of_date: true, request_payload: { saleDate: TODAY } }, TODAY), RATING_OUT_OF_DATE);
  // Rated on 30 Sep, the deal now says 1 Oct: refused even if nothing marked it.
  assert.match(
    staleRatingProblem({ out_of_date: false, request_payload: { saleDate: "2026-09-30" } }, "2026-10-01"),
    /rated with a sale date of 30 Sep 2026, and its sale date is now 1 Oct 2026, in another month/
  );
  // Within the month the rating stands (test/sale-date-month.test.mjs).
  assert.equal(staleRatingProblem({ out_of_date: false, request_payload: { saleDate: "2026-10-27" } }, TODAY), null);
  assert.equal(staleRatingProblem({ out_of_date: false, request_payload: { saleDate: TODAY } }, TODAY), null);
  // An offer rated before requests carried the date has nothing to compare.
  assert.equal(staleRatingProblem({ out_of_date: false, request_payload: {} }, TODAY), null);

  const renew = read("supabase/functions/fni-admin-sessions/index.ts");
  assert.match(renew, /if \(saleMoved\) \{\s*const \{ error: staleErr \} = await supabase\s*\.schema\("fni"\)\s*\.from\("rated_offers"\)\s*\.update\(\{ out_of_date: true \}\)/);
  assert.match(renew, /if \(saleMoved && s\.verification_state === "Verified"\) \{/);

  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /const stale = staleRatingProblem\(ratedOffer, dates\.sale\);\s*if \(stale\) return await refuse\(400, \{ error: stale \}\);/);
  // After the deal's dates are known, and before anything is built or sent.
  assert.ok(submit.indexOf("const stale = ") > submit.indexOf("const dayProblem"));
  assert.ok(submit.indexOf("const stale = ") < submit.indexOf("Step 4: Cut the quote down"));

  // Details disables Submit and says why, in the same words.
  assert.equal(planner.RATING_OUT_OF_DATE, RATING_OUT_OF_DATE);
  assert.equal(planner.submitBlock({ day: { submit_problem: null }, rating: { out_of_date: true } }), RATING_OUT_OF_DATE);
  assert.equal(planner.submitBlock({ day: { submit_problem: "Not today." }, rating: { out_of_date: true } }), "Not today.");
  assert.equal(planner.submitBlock({ day: { submit_problem: null }, rating: { out_of_date: false } }), null);
});

test("no price and no in-service date is touched by a renew", () => {
  const f = read("supabase/functions/fni-admin-sessions/index.ts");
  const renew = f.slice(f.indexOf("async function renew("), f.indexOf("serve(async"));
  assert.doesNotMatch(renew, /in_service_date/);
  assert.doesNotMatch(renew, /_price|_cost|selected_products|response_payload/);
  // The only writes: the session's dates and verification, out_of_date on the
  // offers, the events, and the expiry.
  const writes = [...renew.matchAll(/\.from\("([a-z_]+)"\)\s*\.(update|insert|upsert|delete)/g)].map((m) => `${m[1]}.${m[2]}`);
  assert.deepEqual(writes, ["sessions.update", "rated_offers.update", "session_events.insert"]);
  assert.match(renew, /\.rpc\("renew_session", \{ p_session: sessionId \}\)/);
  // The moves come before the expiry, so a planned date moved to today ends today.
  assert.ok(renew.indexOf("renewDateMoves(") < renew.indexOf('.rpc("renew_session"'));
});
