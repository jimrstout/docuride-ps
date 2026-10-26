// A failed re-rate keeps the last good offers (fix 4b). Only an answer from
// the provider replaces them; a failure is a warning beside them, so the
// status and the customer's choices stand and the deal stays submittable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keepsPrior, keptStillCurrent, keptWarning, sameRatingRequest } from "../supabase/functions/_shared/rerate.ts";
import { providerLine } from "../supabase/functions/_shared/rating-summary.ts";
import { flashMessage } from "../apps/ownership-planner/lib/verify-flash.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const req = { vin: "JKAVN2B1XAA000000", vtype: "MCYC", rateDate: "2026-10-25", properties: [{ name: "price", value: "4999" }] };
const prior = (over = {}) => ({ state: "Rated", out_of_date: false, request_payload: req, product_count: 9, rated_at: "2026-10-25T15:00:00Z", ...over });

test("only a Rated row is kept through a failure", () => {
  assert.equal(keepsPrior(prior()), true);
  assert.equal(keepsPrior(prior({ state: "Not Offered" })), false);
  assert.equal(keepsPrior(prior({ state: "Failed" })), false);
  assert.equal(keepsPrior(null), false);
});

test("the same deal asked another day is the same request; key order does not matter", () => {
  const reordered = { properties: [{ value: "4999", name: "price" }], rateDate: "2026-10-26", vtype: "MCYC", vin: "JKAVN2B1XAA000000" };
  assert.equal(sameRatingRequest(req, reordered), true);
  assert.equal(sameRatingRequest(req, { ...req, vtype: "BIKE" }), false);
  assert.equal(sameRatingRequest(req, { ...req, properties: [{ name: "price", value: "5999" }] }), false);
  assert.equal(sameRatingRequest(req, null), false);
});

test("kept offers are current when the failed request asked about the same deal", () => {
  // Confirm and Continue marks every row out of date, then re-rates: a
  // timeout on the same deal leaves the offers current.
  assert.equal(keptStillCurrent(prior({ out_of_date: true }), { ...req, rateDate: "2026-10-26" }), true);
  // A different deal: the kept offers do not answer it.
  assert.equal(keptStillCurrent(prior(), { ...req, vtype: "BIKE" }), false);
  // No request built: the flag it had stands.
  assert.equal(keptStillCurrent(prior({ out_of_date: false }), null), true);
  assert.equal(keptStillCurrent(prior({ out_of_date: true }), undefined), false);
});

test("the warning says what failed and what was kept, in plain English", () => {
  const ok = keptWarning("Riders Advantage", "Rating failed: timed out after 30s.", true);
  assert.equal(ok, "Riders Advantage could not rate again (Rating failed: timed out after 30s). The last good offers are kept, so the deal can still go ahead on them.");
  assert.match(keptWarning("Riders Advantage", "x", false), /out of date, so rate again before submitting\.$/);
  for (const s of [ok]) assert.doesNotMatch(s, /—/);
});

test("Verify's provider line carries the warning", () => {
  const row = { provider_id: "p", state: "Rated", product_count: 9, rated_at: null, error_detail: null, out_of_date: false,
    response_payload: {}, last_failure_detail: "Rating failed: timed out.", provider: { id: "p", name: "Riders Advantage", kind: "Connected", adapter: "TecAssured" } };
  assert.equal(providerLine(row), "Riders Advantage: Rated, 9 products. The last re-rate failed (Rating failed: timed out), so these are the earlier offers, kept.");
  assert.equal(providerLine({ ...row, last_failure_detail: null }), "Riders Advantage: Rated, 9 products.");
  const flash = flashMessage({ code: "ratedkept", detail: "Riders Advantage could not rate again (x)." });
  assert.equal(flash.text, "Verified. Riders Advantage could not rate again (x).");
});

test("recordOutcome keeps a Rated row and never writes Failed over it", () => {
  const rate = src("../supabase/functions/_shared/rate-session.ts");
  const fn = rate.slice(rate.indexOf("export async function recordOutcome("), rate.indexOf("export async function rateSession("));
  assert.match(fn, /if \(keepsPrior\(prior\)\)/);
  assert.match(fn, /last_failure_detail: reason/);
  // The kept branch returns before the upsert.
  assert.ok(fn.indexOf("return { product_count: prior.product_count") < fn.indexOf(".upsert("));
  // An answer clears the warning.
  assert.match(fn, /last_failure_detail: null,\s+last_failure_at: null/);
});

test("a timed-out TecAssured call still records what it asked", () => {
  const ad = src("../supabase/functions/_shared/adapters/tecassured.ts");
  assert.match(ad, /response = await store\.client\.rateVehicle\(request\);\s+\} catch \(err\) \{\s+return \{\s+state: "Failed",\s+request,/);
});

test("rate-vehicle answers with the kept offers and leaves the status alone", () => {
  const rv = src("../supabase/functions/fni-rate-vehicle/index.ts");
  assert.match(rv, /if \(productCount === 0 && keptCount > 0\) \{[\s\S]*?status: sess\.status,[\s\S]*?kept_offers: true,/);
  assert.match(rv, /status: productCount > 0 \? /);
});
