#!/usr/bin/env node
// scripts/same-month-rating-check.mjs
//
// Which out-of-date offers the same-month rule would have kept current.
// Run once for migration 0039 (supabase/migrations/0039_same_month_rating_current.sql).
//
// Input: a JSON array, one row per out-of-date TecAssured offer, as
//   { deal_number, session, stored }
// where `session` is the fni.sessions row (rating inputs; personal columns
// may be left out, the request does not use them) and `stored` is the
// offer's request_payload. Deal 14957 is never part of the input.
//
// For each row the request the session would send now is rebuilt with the
// same builder rating uses, holding the provider's own choices (dealer code,
// vehicle type code, the properties it asked for, the rate date) at the
// stored request's, so only the deal's inputs can differ. ratedRequestDiff
// (_shared/sale-date.ts) then says whether only the sale date moved, within
// its month. Prints one line per deal; changes nothing.
//
// Usage: node --experimental-strip-types scripts/same-month-rating-check.mjs rows.json [boundary ...]

import { readFileSync } from "node:fs";
import { buildRateRequest } from "../supabase/functions/_shared/rate-request.ts";
import { applyStaffEdits, parseStaffEdits } from "../supabase/functions/_shared/staff-edits.ts";
import { ratedRequestDiff } from "../supabase/functions/_shared/sale-date.ts";

/** The decision for one offer. Exported for the test. */
export function checkRow(row, boundaries = []) {
  const source = applyStaffEdits(row.session, parseStaffEdits(row.session.staff_edits));
  const required = (row.stored.properties ?? []).map((p) => ({ name: p.name }));
  const built = buildRateRequest(required, source, {
    dealerCode: row.stored.dealerCode,
    vtype: row.stored.vtype,
    rateDate: row.stored.rateDate,
  });
  return ratedRequestDiff(row.stored, built.request, boundaries);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...boundaries] = process.argv.slice(2);
  for (const row of JSON.parse(readFileSync(file, "utf8"))) {
    if (row.deal_number === "14957") continue;
    const d = checkRow(row, boundaries);
    console.log(
      `${row.deal_number}: ${d.keepCurrent ? "mark current" : "leave out of date"}; ` +
        `rated on ${d.rated_sale}, now ${d.current_sale}; differs: ${d.differs.join(", ") || "nothing"}`
    );
  }
}
