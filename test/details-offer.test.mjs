// Details after Rate again: updated from the rating's answer, never drawn
// again, and the same as a full reload (speed part 2).
//
// The proof has three parts, and scripts/rate-again-check.mjs adds a fourth
// in a real browser (the screen after Rate again against the screen after a
// reload, with a 15 second answer):
//   1. One function builds the part of the sheet a rating changes, and both
//      Details' load (fni-session-verify) and Rate again's answer
//      (fni-rate-vehicle) use it, for exactly the same keys.
//   2. Rate again's answer is built after everything the rating writes,
//      the "Rated again" event included, from the session as it then stands.
//   3. Putting the answer over the sheet on the screen gives exactly the
//      sheet a reload gives: the same keys replaced, nothing else touched.
// Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isOfferDetails, mergeOfferDetails, OFFER_KEYS } from "../apps/ownership-planner/lib/details-offer.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const shared = read("supabase/functions/_shared/details-offer.ts");
const verify = read("supabase/functions/fni-session-verify/index.ts");
const rate = read("supabase/functions/fni-rate-vehicle/index.ts");

test("1. the page and the Edge Function name the same keys", () => {
  const edgeKeys = [...shared.slice(shared.indexOf("export const OFFER_KEYS"), shared.indexOf("] as const;")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(edgeKeys, [...OFFER_KEYS]);
});

test("1. Details' load takes every one of those keys, and the status, from the shared function", () => {
  assert.match(verify, /import \{ menuColumnsFor, offerParts \} from "\.\.\/_shared\/details-offer\.ts";/);
  assert.match(verify, /const offerRead = offerParts\(supabase, s\);/);
  for (const key of OFFER_KEYS) {
    assert.match(verify, new RegExp(`\\n    ${key}: offer\\.${key},`), key);
    // And builds it nowhere else.
    assert.equal((verify.match(new RegExp(`\\b${key}:`, "g")) ?? []).length, 1, key);
  }
  assert.match(verify, /status: offer\.session_status,/);
  // The shared function returns exactly those keys and the status.
  const ret = shared.slice(shared.indexOf("  return {\n    session_status"), shared.indexOf("\n  };\n}", shared.indexOf("  return {\n    session_status")));
  const returned = [...ret.matchAll(/\n    ([a-z_]+):/g)].map((m) => m[1]);
  assert.deepEqual(returned.sort(), ["session_status", ...OFFER_KEYS].sort());
});

test("2. Rate again answers with the same function, after the event, from the session as it now stands", () => {
  assert.match(rate, /import \{ offerParts \} from "\.\.\/_shared\/details-offer\.ts";/);
  const again = rate.slice(rate.indexOf("async function rateAgain("));
  assert.match(again, /const answer = async \(status: number, body: Record<string, unknown>\) => \{\s*const \{ data: fresh \} = await supabase\.schema\("fni"\)\.from\("sessions"\)\.select\("\*"\)\.eq\("id", sess\.id\)\.maybeSingle\(\);[\s\S]*?offerParts\(supabase, fresh as Record<string, unknown>\)/);
  // Every answer after a rating carries it; each comes after the event is written.
  for (const outcome of ['outcome: "rated"', 'outcome: unchanged ? "unchanged" : "changed"']) {
    const at = again.indexOf(`return await answer(200, { session_id: sess.id, ${outcome}`);
    assert.ok(at > 0, outcome);
    assert.ok(again.lastIndexOf("await record(", at) > again.lastIndexOf("timing.mark(\"session updated\")", at), outcome);
  }
  assert.match(again, /await record\(\{ outcome: "failed", reason \}\);[\s\S]*?return await answer\(502,/);
  // And never a second reading of the deal or the DX1 check.
  assert.doesNotMatch(rate, /fni-session-verify|fni-dx1-check|sheetFor\(/);
});

// ── 3. The merge, with two made-up sheets: before and after a rating ─────────
const before = {
  session: { id: "s1", deal_number: "99901", stock_number: "ST-1", status: "Rated", is_test: true, vehicle: "2026 Mockmake Trail", deal_type: "Finance", vehicle_type_code: "UTV" },
  provider_name: "Mock Provider",
  verification: { state: "Verified", verified_at: "2026-11-02T13:00:00Z", verified_by: "JS" },
  rating: { state: "Rated", product_count: 11, out_of_date: false, rated_at: "2026-11-02T13:00:05Z", detail: null, providers: [{ name: "Mock Provider", state: "Rated", line: "Mock Provider: Rated, 11 products." }] },
  rating_differences: null,
  menu_columns: [{ position: 1, name: "Gold", template_level: "Middle", level: "Middle" }],
  prepared: null,
  menu_template: { name: "UTV menu" },
  unplaced_offers: [],
  rating_notices: [],
  hidden_slots: [],
  oem_contracts: [],
  contracts_panel: null,
  contracts: [],
  day: { time_zone: "America/New_York", today: "2026-11-02", sale_date: "2026-11-02" },
  fields: [{ key: "vin", value: "SAMPLEVIN" }],
  ready: true,
  submit_state: "Idle",
};
const reloaded = {
  ...before,
  session: { ...before.session, status: "Products Selected" },
  rating: { ...before.rating, product_count: 12, rated_at: "2026-11-02T14:01:00Z", providers: [{ name: "Mock Provider", state: "Rated", line: "Mock Provider: Rated, 12 products." }] },
  rating_differences: { message: "Out of date.", differences: ["Sample Plan: $1,295.00 is now $1,310.00."] },
  menu_columns: [{ position: 1, name: "Gold", template_level: "Highest", level: "Highest" }],
  unplaced_offers: ["1 Maintenance plan was offered but no menu row uses it."],
  rating_notices: ["Sample notice."],
  hidden_slots: [{ title: "Theft", note: "Not offered." }],
  contracts_panel: { provider_name: "Mock Provider", selections: [], contracts: [], waiting_count: 0, confirmation: null },
};
const answer = {
  session_status: reloaded.session.status,
  ...Object.fromEntries(OFFER_KEYS.map((k) => [k, reloaded[k]])),
};

test("3. the answer put over the screen's sheet is exactly the reloaded sheet", () => {
  assert.ok(isOfferDetails(answer));
  assert.deepEqual(mergeOfferDetails(before, answer), reloaded);
  // Nothing else is touched, and the sheet on the screen is not changed in place.
  const merged = mergeOfferDetails(before, answer);
  for (const key of Object.keys(before)) {
    if (key === "session" || OFFER_KEYS.includes(key)) continue;
    assert.equal(merged[key], before[key], key);
  }
  assert.equal(before.rating.product_count, 11);
});

test("3. an answer missing any key is not used: the page is drawn again instead", () => {
  for (const key of ["session_status", ...OFFER_KEYS]) {
    const { [key]: _gone, ...short } = answer;
    assert.equal(isOfferDetails(short), false, key);
  }
  assert.equal(isOfferDetails(null), false);
});

test("Rate again on Details: no page drawn again, the job ends on the answer", () => {
  const body = read("apps/ownership-planner/app/details/[sessionId]/DetailsBody.tsx");
  assert.match(body, /<form action=\{rateAgainHere\} className="vrate-again" data-working-redraw="none">/);
  assert.match(body, /sheet: mergeOfferDetails\(sheet, answer\.details!\),/);
  assert.match(body, /\} finally \{\s*workingDone\(\);\s*\}/);
  // A later server draw of the page wins over Rate again's answer.
  assert.match(body, /const rated = ratedHere && ratedHere\.base === loaded \? ratedHere : null;/);
  const action = read("apps/ownership-planner/app/console-actions.ts");
  const fn = action.slice(action.indexOf("export async function rateAgain("), action.indexOf("\n}\n", action.indexOf("export async function rateAgain(")));
  // Nothing that makes Next draw the page again, unless the answer cannot be used.
  const used = fn.slice(0, fn.indexOf("if (!answer.details) {"));
  assert.doesNotMatch(used, /revalidatePath|backToVerify|cookies\(/);
  const w = read("apps/ownership-planner/components/Working.tsx");
  assert.match(w, /if \(!answersItself\(\)\) finish\(\);/);
  // The other actions still wait for the page to be drawn again.
  assert.match(w, /renderBefore: form\.dataset\.workingRedraw === "none" \? null : renderStamp\(\),/);
});
