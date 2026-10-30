// Rate again on Details (2026-10-28). On deal 15029 the only way to force a
// fresh rating was Confirm and Continue, shown only while the deal needed
// verifying. Rate again rates any time, keeps each selection the fresh offer
// matches to the cent, and lists the rest as out of date. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compareRefreshed,
  differenceText,
  isRatedAgainEvent,
  OUT_OF_DATE_MESSAGE,
  ratedAgainEvent,
  refreshState,
} from "../supabase/functions/_shared/spent-rates.ts";
import { renewedBy } from "../supabase/functions/_shared/sale-date.ts";
import { rateAgainAvailable } from "../apps/ownership-planner/lib/rate-again.ts";
import { flashMessage } from "../apps/ownership-planner/lib/verify-flash.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const money = (n) => `$${n.toFixed(2)}`;
const PAGE = "apps/ownership-planner/app/details/[sessionId]/page.tsx";
const RATE = "supabase/functions/fni-rate-vehicle/index.ts";
const rateAgainFn = () => {
  const src = read(RATE);
  return src.slice(src.indexOf("async function rateAgain("));
};

const rate = (id, over = {}) => ({
  rate_unique_id: id, term_months: 36, term_miles: 0, deductible: 0, deductible_code: "0 Ded",
  disappearing_deductible: false, dealer_cost: 200, provider_markup: 0, offered_price: 600,
  options: [], raw: { unique: id }, retail_price: 400, ...over,
});
const tier = (code, name, rates) => ({ product_code: code, product_name: name, product_type: code, rates, raw: {} });
const families = (...tiers) => [{ family_code: "F", provider_id: "p1", provider_name: "Sample Provider", tiers }];
const sel = (code, name, rateId, price) => ({
  id: `sel-${code}`, provider_id: "p1", provider_product_id: code, product_name: name,
  rate_unique_id: rateId, selected_options: [], customer_price: price,
});

test("offered when signed in, not when signed out", () => {
  assert.equal(rateAgainAvailable({ signedIn: true, submitState: "Idle" }), true);
  assert.equal(rateAgainAvailable({ signedIn: false, submitState: "Idle" }), false);
  // Whatever the rating says, and whatever contracts are live: neither is an input.
  assert.match(read(PAGE), /rateAgainAvailable\(\{ signedIn: !!operator, submitState: sheet\.submit_state \}\) \? \(/);
  // The action needs a signed-in person too.
  const actions = read("apps/ownership-planner/app/console-actions.ts");
  const action = actions.slice(actions.indexOf("export async function rateAgain("));
  assert.match(action, /const operator = await currentOperator\(\);\s*if \(!operator\) redirect\(SESSIONS\);/);
});

test("not offered while a submit is running; a live contract does not stop it", () => {
  for (const submitState of ["In Progress", "Submit Status Unknown"]) {
    assert.equal(rateAgainAvailable({ signedIn: true, submitState }), false, submitState);
  }
  // The Edge Function refuses a running submit itself, before rating, and
  // no longer refuses a live contract.
  const fn = rateAgainFn();
  const rates = fn.indexOf("await rateSession(");
  assert.ok(fn.indexOf('if (submitState !== "Idle")') < rates);
  assert.doesNotMatch(fn, /cannot be rated again\. Void it first\./);
  // Purchased products are left out before anything is compared or moved.
  assert.ok(fn.indexOf("const selections = notPurchased(") < fn.indexOf("compareRefreshed("));
});

test("rating with live contracts: purchased products are never touched, and the status stays", async () => {
  const { notPurchased, purchasedKeys, ratingRefused, statusAfterRatingWithContracts } = await import("../supabase/functions/_shared/purchased.ts");
  const bought = purchasedKeys([
    { provider_id: "p1", provider_product_id: "BATT", status: "Live" },
    { provider_id: "p1", provider_product_id: "TIRE", status: "Voided" },
  ]);
  assert.deepEqual(notPurchased([sel("BATT", "Sample Battery", "100", 400), sel("TIRE", "Sample Tire", "200", 300)], bought).map((s) => s.provider_product_id), ["TIRE"]);
  // A rating keeps the status while a contract is live, so the contracts panel stays.
  assert.equal(statusAfterRatingWithContracts("Finalized", "Rated", bought), "Finalized");
  assert.equal(statusAfterRatingWithContracts("Products Selected", "Rated", new Set()), "Rated");
  // A Finalized session rates while it has a live contract; Written Back and Cancelled never.
  assert.equal(ratingRefused("Finalized", bought), false);
  assert.equal(ratingRefused("Finalized", new Set()), true);
  assert.equal(ratingRefused("Written Back", bought), true);
  assert.equal(ratingRefused("Cancelled", bought), true);
  assert.equal(ratingRefused("Agreement Created", bought), false);
  const fn = read("supabase/functions/fni-rate-vehicle/index.ts");
  assert.match(fn, /const purchased = await purchasedFor\(supabase, sess\.id\);\s*if \(ratingRefused\(sess\.status, purchased\)\) \{/);
  assert.match(fn, /choicesStillOffered\(notPurchased\(\(chosenRows \?\? \[\]\) as ChosenRate\[\], purchased\), offeredRates, keptProviders\)/);
  assert.match(fn, /selections\.length === 0 && purchased\.size === 0 \? \{ status: statusAfterRating\(/);
});

test("selections the fresh offer matches to the cent are kept on the fresh rate", () => {
  const before = families(tier("BATT", "Sample Battery", [rate("100")]), tier("TIRE", "Sample Tire", [rate("200", { dealer_cost: 150, retail_price: 300 })]));
  const after = families(tier("BATT", "Sample Battery", [rate("101")]), tier("TIRE", "Sample Tire", [rate("201", { dealer_cost: 150.01, retail_price: 300 })]));
  const r = compareRefreshed([sel("BATT", "Sample Battery", "100", 400), sel("TIRE", "Sample Tire", "200", 300)], before, after);
  assert.deepEqual(r.lines.map((l) => [l.status, l.to_rate]), [["unchanged", "101"], ["changed", "201"]]);
  // Rate again moves each matching one on its own; any other stays where it was.
  const fn = rateAgainFn();
  assert.match(fn, /if \(l\.status !== "unchanged" \|\| l\.from_rate === l\.to_rate\) continue;[\s\S]*?\.update\(\{ rate_unique_id: l\.to_rate, rate_snapshot: l\.snapshot \}\)/);
  // With selections, or a live contract, the status stays, so the contracts panel stays.
  assert.match(fn, /\.\.\.\(selections\.length === 0 && purchased\.size === 0 \? \{ status: statusAfterRating\(/);
});

test("differences are listed on Details as out of date", () => {
  const lines = [
    { product_name: "Sample Battery", provider_product_id: "BATT", from_rate: "100", to_rate: "101", status: "unchanged",
      old: { dealer_cost: 200, option_cost: 0, customer_price: 400 }, new: { dealer_cost: 200, option_cost: 0, customer_price: 400 } },
    { product_name: "Sample Tire", provider_product_id: "TIRE", from_rate: "200", to_rate: "201", status: "changed",
      old: { dealer_cost: 150, option_cost: 0, customer_price: 300 }, new: { dealer_cost: 150.01, option_cost: 0, customer_price: 300 } },
    { product_name: "Sample Wheel", provider_product_id: "WHEEL", from_rate: "300", to_rate: null, status: "missing",
      old: { dealer_cost: 90, option_cost: 0, customer_price: 200 }, new: null },
  ];
  const latest = { event: ratedAgainEvent("JS"), created_at: "2026-10-28T20:00:00Z", detail: { outcome: "changed", lines } };
  const now = [
    { provider_product_id: "BATT", rate_unique_id: "101" },
    { provider_product_id: "TIRE", rate_unique_id: "200" },
    { provider_product_id: "WHEEL", rate_unique_id: "300" },
  ];
  assert.deepEqual(refreshState(now, latest, money), {
    kind: "held",
    differences: ["Sample Tire: dealer cost $150.00 to $150.01.", "Sample Wheel: no longer offered."],
  });
  assert.equal(differenceText(lines[2], money), "Sample Wheel: no longer offered.");
  // Chosen again since: nothing left to list.
  assert.equal(refreshState([{ provider_product_id: "TIRE", rate_unique_id: "201" }, { provider_product_id: "WHEEL", rate_unique_id: "301" }], latest, money), null);
  const page = read(PAGE);
  assert.match(page, /\{sheet\.rating_differences \? \([\s\S]*?<li key=\{d\}>Out of date\. \{d\}<\/li>/);
  assert.match(read("supabase/functions/fni-session-verify/index.ts"), /return state\?\.kind === "held" \? \{ message: OUT_OF_DATE_MESSAGE, differences: state\.differences \} : null;/);
  assert.doesNotMatch(OUT_OF_DATE_MESSAGE, /—|DX1/);
  // The Submit confirmation is held by the same state (spentStateFor).
  assert.match(read("supabase/functions/fni-session-verify/index.ts"), /const state = refreshState\(selections, await latestRefreshEvent\(supabase, s\.id as string\), money\);/);
});

test("a rating error is shown with Show details and Copy error, and nothing is kept as rated", () => {
  const fn = rateAgainFn();
  assert.match(fn, /if \(rated\.length === 0 \|\| productCount === 0\) \{[\s\S]*?await record\(\{ outcome: "failed", reason \}\);[\s\S]*?return json\(502,/);
  // The provider's words are in the rating banner (failed now, or kept after a failed re-rate).
  assert.equal(
    flashMessage({ code: "rateagainfailed", detail: "x" }, { ratingShown: true }).text,
    "The deal could not be rated again. The provider's error is below."
  );
  assert.equal(flashMessage({ code: "rateagainfailed", detail: "The deal could not be rated again. Sample fault." }).text,
    "The deal could not be rated again. Sample fault.");
  assert.match(read(PAGE), /<RatingErrorText deal=\{sheet\.session\.deal_number\} failures=\{ratingFailuresShown\} \/>/);
  // Never a submit.
  assert.doesNotMatch(fn, /submitContract|fni-contract-submit/);
});

test("a double tap rates once: the busy button sends one request", () => {
  const page = read(PAGE);
  assert.match(page, /<form action=\{rateAgain\} className="vrate-again" data-working-panel="">\s*<Working \/>\s*<input type="hidden" name="session_id" value=\{sheet\.session\.id\} \/>\s*<PendingButton pending="Rating again\.\.\.">Rate again<\/PendingButton>/);
  const button = read("apps/ownership-planner/components/PendingButton.tsx");
  assert.match(button, /disabled=\{disabled \|\| busy\}/);
});

test("every press is recorded as Rated again by the initials, or by System", () => {
  assert.equal(ratedAgainEvent(renewedBy("js")), "Rated again by JS");
  assert.equal(ratedAgainEvent(renewedBy(undefined)), "Rated again by System");
  assert.ok(isRatedAgainEvent("Rated again by JS"));
  assert.ok(!isRatedAgainEvent("Rating refreshed after a void: prices unchanged"));
  const fn = rateAgainFn();
  assert.match(fn, /const who = renewedBy\(by\);\s*const event = ratedAgainEvent\(who\);/);
  assert.match(fn, /\.insert\(\{ session_id: sess\.id, event, detail, created_by: who \}\)/);
  assert.match(read(RATE), /return await rateAgain\(supabase, sess, rateSource, body\.rated_by, purchased\);/);
  assert.match(read("apps/ownership-planner/app/console-actions.ts"), /rate_again: true,[\s\S]*?rated_by: initialsFor\(operator\.email\),/);
});
