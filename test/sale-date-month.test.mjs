// A sale date moved within the same calendar month keeps the rating current
// (2026-10-28). Jim's rule: rate cards change at month boundaries, so only a
// move into another month or year, or across the day a price sheet takes
// over, needs a re-rate. Every path that used to mark the rating out of date
// for a moved sale date follows the one rule. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  monthOf,
  onlySameMonthSaleDateMove,
  priceSheetBoundaries,
  RATING_OUT_OF_DATE,
  renewDateMoves,
  saleDateMoveNeedsRerate,
  staleRatingProblem,
} from "../supabase/functions/_shared/sale-date.ts";
import { storeToday } from "../supabase/functions/_shared/store-day.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const offer = (saleDate, out_of_date = false) => ({ out_of_date, request_payload: { saleDate } });

test("a same-month move keeps the rating current and the deal verified", () => {
  assert.equal(saleDateMoveNeedsRerate("2026-10-27", "2026-10-28"), false);
  assert.equal(saleDateMoveNeedsRerate("2026-10-01", "2026-10-31"), false);
  assert.equal(saleDateMoveNeedsRerate("2026-10-28", "2026-10-28"), false);
  assert.equal(monthOf("2026-10-28"), "2026-10");

  // Renew: the deal is un-verified and its offers marked only when the move needs a re-rate.
  const renew = read("supabase/functions/fni-admin-sessions/index.ts");
  assert.match(renew, /const saleMoved = !!saleMove &&\s*saleDateMoveNeedsRerate\(saleMove\.from, saleMove\.to, sheets === null \? null : priceSheetBoundaries\(sheets\)\);/);
  assert.match(renew, /if \(saleMoved && s\.verification_state === "Verified"\) \{/);
  assert.match(renew, /if \(saleMoved\) \{\s*const \{ error: staleErr \} = await supabase\s*\.schema\("fni"\)\s*\.from\("rated_offers"\)\s*\.update\(\{ out_of_date: true \}\)/);
  // The move's session event is still written, and says whether a re-rate was needed.
  assert.match(renew, /\.from\("session_events"\)\s*\.insert\(moves\.map\(/);
  assert.match(renew, /rerate_needed: m\.field === "sale_date" && saleMoved/);
});

test("a month boundary (31 Oct to 1 Nov) needs a re-rate", () => {
  assert.equal(saleDateMoveNeedsRerate("2026-10-31", "2026-11-01"), true);
  assert.equal(saleDateMoveNeedsRerate("2026-11-01", "2026-10-31"), true);
});

test("a year boundary (31 Dec to 1 Jan) needs a re-rate, and so does the same month a year apart", () => {
  assert.equal(saleDateMoveNeedsRerate("2026-12-31", "2027-01-01"), true);
  assert.equal(saleDateMoveNeedsRerate("2026-10-15", "2027-10-15"), true);
});

test("a missing date on either side needs a re-rate", () => {
  assert.equal(saleDateMoveNeedsRerate(null, "2026-10-28"), true);
  assert.equal(saleDateMoveNeedsRerate("2026-10-28", null), true);
  assert.equal(saleDateMoveNeedsRerate(null, null), false);
});

test("Submit allows a same-month rating and refuses a cross-month one", () => {
  assert.equal(staleRatingProblem(offer("2026-10-27"), "2026-10-28"), null);
  // TecAssured's own format, as a quote echoes it.
  assert.equal(staleRatingProblem(offer("Oct 2, 2026, 6:53:44 PM"), "2026-10-28"), null);
  assert.match(staleRatingProblem(offer("2026-10-31"), "2026-11-01"), /in another month/);
  assert.match(staleRatingProblem(offer("2026-12-31"), "2027-01-01"), /in another month/);
  // Within the month, the stored quote goes with the deal's current dates, as before.
  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /const stale = staleRatingProblem\(ratedOffer, dates\.sale\);/);
  assert.match(submit, /alignContractDates\(/);
  assert.ok(submit.indexOf("const stale = ") < submit.lastIndexOf("alignContractDates("));
});

test("the store's time zone decides the month", () => {
  // 03:00 UTC on 1 Nov: already November in UTC, still 31 Oct in Los Angeles.
  const now = new Date("2026-11-01T03:00:00Z");
  const today = storeToday("America/Los_Angeles", now);
  assert.equal(today, "2026-10-31");
  assert.equal(now.toISOString().slice(0, 10), "2026-11-01");
  // Renew moves 30 Oct to the store's today, 31 Oct: the same month, no re-rate.
  const [move] = renewDateMoves({ sale: "2026-10-30", planned: null, today });
  assert.deepEqual([move.from, move.to], ["2026-10-30", "2026-10-31"]);
  assert.equal(saleDateMoveNeedsRerate(move.from, move.to), false);
  // Judged by the UTC date it would have been November, and a re-rate.
  assert.equal(saleDateMoveNeedsRerate("2026-10-30", now.toISOString().slice(0, 10)), true);
  // The renew takes today from the store's zone.
  assert.match(read("supabase/functions/fni-admin-sessions/index.ts"), /const today = storeToday\(\(storeRow as \{ time_zone\?: string \} \| null\)\?\.time_zone \?\? null\);/);
});

test("a rating out of date for another cause stays out of date after a same-month move", () => {
  assert.equal(staleRatingProblem(offer("2026-10-27", true), "2026-10-28"), RATING_OUT_OF_DATE);
  // Nothing on these paths ever marks an offer current: they only add the mark.
  for (const f of [
    "supabase/functions/fni-admin-sessions/index.ts",
    "supabase/functions/fni-session-verify/index.ts",
    "supabase/functions/fni-session-start/index.ts",
  ]) {
    assert.doesNotMatch(read(f), /out_of_date: false/, f);
  }
  // A same-month move on Details returns before the session or its offers are written.
  const verify = read("supabase/functions/fni-session-verify/index.ts");
  const fn = verify.slice(verify.indexOf("async function unverifyIfInputsMoved("), verify.indexOf("// ── save: any field that feeds a rate"));
  const early = fn.indexOf("return [];");
  assert.ok(early > 0 && early < fn.indexOf('.update({ out_of_date: true })'));
});

test("editing the sale date on Details, refreshing it from the CRM, or relaunching follows the same rule", () => {
  const before = { sale_date: "2026-10-27", in_service_date: "2026-10-27", odometer: "5" };
  const after = { sale_date: "2026-10-28", in_service_date: "2026-10-28", odometer: "5" };
  // A New unit: the in-service date follows the sale date.
  assert.equal(onlySameMonthSaleDateMove(["in_service_date", "sale_date"], before, after), true);
  assert.equal(onlySameMonthSaleDateMove(["sale_date"], before, { ...after, in_service_date: "2026-10-27" }), true);
  // Across the month, it is a change like any other.
  assert.equal(onlySameMonthSaleDateMove(["sale_date"], before, { ...after, sale_date: "2026-11-01" }), false);
  // Anything else moved with it: handled as before.
  assert.equal(onlySameMonthSaleDateMove(["odometer", "sale_date"], before, { ...after, odometer: "9" }), false);
  // A used unit's own in-service date changing is not the sale date following.
  assert.equal(onlySameMonthSaleDateMove(["in_service_date", "sale_date"], { ...before, in_service_date: "2025-01-01" }, { ...after, in_service_date: "2025-02-01" }), false);
  // No sale date change, or no snapshot: not this rule.
  assert.equal(onlySameMonthSaleDateMove(["odometer"], before, after), false);
  assert.equal(onlySameMonthSaleDateMove(["sale_date"], null, after), false);

  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /if \(onlySameMonthSaleDateMove\(changed, before, after, sheets === null \? null : priceSheetBoundaries\(sheets\)\)\) \{\s*return \[\];/);
  const start = read("supabase/functions/fni-session-start/index.ts");
  assert.match(start, /if \(onlySameMonthSaleDateMove\(changed, before, after, sheets === null \? null : priceSheetBoundaries\(sheets\)\)\) \{\s*return \[\];/);
});

test("a price sheet that starts or ends between the dates counts as a boundary", () => {
  const b = priceSheetBoundaries([
    { effective_from: "2026-10-15", effective_to: null },
    { effective_from: "2026-09-01", effective_to: "2026-10-20" },
  ]);
  assert.deepEqual(b, ["2026-09-01", "2026-10-15", "2026-10-21"]);
  assert.equal(saleDateMoveNeedsRerate("2026-10-10", "2026-10-15", b), true); // the new sheet's first day
  assert.equal(saleDateMoveNeedsRerate("2026-10-16", "2026-10-20", b), false);
  assert.equal(saleDateMoveNeedsRerate("2026-10-20", "2026-10-21", b), true); // the day after a sheet ends
  // Sheets that could not be read: the safe answer.
  assert.equal(saleDateMoveNeedsRerate("2026-10-16", "2026-10-20", null), true);
  assert.equal(saleDateMoveNeedsRerate("2026-10-16", "2026-10-16", null), false);
  const rows = read("supabase/functions/_shared/price-sheet-rows.ts");
  assert.match(rows, /\.from\("price_sheets"\)\s*\.select\("effective_from, effective_to"\)\s*\.eq\("status", "Published"\)\s*\.eq\("tenant_id", tenantId\);/);
});

test("the confirmation still shows the rows the submit sends, and no price is written", () => {
  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /\.select\(SUBMIT_ROW_COLUMNS\)/);
  for (const f of ["supabase/functions/_shared/sale-date.ts", "supabase/functions/fni-admin-sessions/index.ts"]) {
    assert.doesNotMatch(read(f), /customer_price|retail_price|dealer_cost|selected_products/, f);
  }
});
