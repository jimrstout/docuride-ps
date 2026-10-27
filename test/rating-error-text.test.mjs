// Rating errors sized for people (2026-10-27): the Edge Functions hand the
// planner each provider's exact error text, as stored, alongside the line
// they already sent. Nothing new is stored; the planner makes the one-line
// summary (apps/ownership-planner/lib/rating-error.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ratingSummary } from "../supabase/functions/_shared/rating-summary.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const RA = { id: "prov-ra", name: "Riders Advantage", kind: "Connected", adapter: "TecAssured" };
const SOAP =
  "TecAssured refused the rate request: Client received SOAP Fault from server: The formatter threw an exception.";
const row = (over = {}) => ({
  provider_id: RA.id, state: "Rated", product_count: 11, rated_at: "2026-10-27T13:03:29Z",
  error_detail: null, out_of_date: false, response_payload: null, provider: RA, ...over,
});

test("a failed provider carries its exact error text and time", () => {
  const s = ratingSummary([row({ state: "Failed", product_count: 0, error_detail: SOAP })]);
  assert.equal(s.state, "Failed");
  assert.deepEqual(s.failures, [{ provider: "Riders Advantage", text: SOAP, at: "2026-10-27T13:03:29Z" }]);
  assert.equal(s.providers[0].error, SOAP);
  assert.equal(s.providers[0].error_at, "2026-10-27T13:03:29Z");
  assert.equal(s.providers[0].kept_error, null);
  // The line and the joined detail are as they were.
  assert.equal(s.providers[0].line, `Riders Advantage: ${SOAP}`);
  assert.equal(s.detail, `Riders Advantage: ${SOAP}`);
});

test("a rated or not offered provider has no error; kept offers carry the re-rate failure", () => {
  const s = ratingSummary([
    row({ last_failure_detail: SOAP, last_failure_at: "2026-10-27T00:17:35Z" }),
  ]);
  assert.deepEqual(s.failures, []);
  assert.equal(s.providers[0].error, null);
  assert.equal(s.providers[0].kept_error, SOAP);
  assert.equal(s.providers[0].kept_error_at, "2026-10-27T00:17:35Z");
  const n = ratingSummary([row({ state: "Not Offered", product_count: 0, error_detail: "Nothing offered." })]);
  assert.deepEqual(n.failures, []);
  assert.equal(n.providers[0].error, null);
});

test("no rows is Pending with no failures", () => {
  assert.deepEqual(ratingSummary([]).failures, []);
});

test("the session list and Details pass the exact text through", () => {
  const list = src("../supabase/functions/fni-admin-sessions/index.ts");
  assert.match(list, /last_failure_at, product_count/);
  assert.match(list, /failures: summary\.state === "Rated" \? \[\] : summary\.failures/);
  const details = src("../supabase/functions/fni-session-verify/index.ts");
  assert.match(details, /error: p\.error,/);
  assert.match(details, /kept_error: p\.kept_error,/);
});
