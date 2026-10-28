// A rate is spent once a contract made from it is voided (2026-10-28). The
// provider then refuses it ("One or more of these products have been voided.
// Please re-rate and try again"), so Submit contracts refreshes the rating
// first, the way iTap does. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HELD_MESSAGE,
  REFRESHED_HELD_EVENT,
  REFRESHED_NOTE,
  REFRESHED_UNCHANGED_EVENT,
  compareRefreshed,
  differenceText,
  refreshState,
  spentSelections,
} from "../supabase/functions/_shared/spent-rates.ts";
import * as flash from "../apps/ownership-planner/lib/verify-flash.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const money = (n) => `$${n.toFixed(2)}`;

const rate = (id, over = {}) => ({
  rate_unique_id: id,
  term_months: 36,
  term_miles: 0,
  deductible: 0,
  deductible_code: "0 Ded",
  disappearing_deductible: false,
  dealer_cost: 200,
  provider_markup: 0,
  offered_price: 600,
  options: [{ code: "COMM", label: "Commercial", cost_delta: 25, mandatory: false, applied: false }],
  raw: { unique: id },
  retail_price: 400,
  ...over,
});
const families = (...rates) => [
  {
    family_code: "BATT",
    provider_id: "p1",
    provider_name: "Sample Provider",
    tiers: [{ product_code: "BATT-STD", product_name: "Sample Battery", product_type: "BATT", rates, raw: {} }],
  },
];
const selection = (over = {}) => ({
  id: "sel1",
  provider_id: "p1",
  provider_product_id: "BATT-STD",
  product_name: "Sample Battery",
  rate_unique_id: "34347",
  selected_options: ["COMM"],
  customer_price: 425,
  ...over,
});
const voided = { provider_product_id: "BATT-STD", rate_unique_id: "34347", status: "Voided", voided_at: "2026-10-28T16:00:00Z" };

test("no spent rate: the modal opens as now, with no re-rate", () => {
  assert.deepEqual(spentSelections([selection()], [], "2026-10-28T15:00:00Z"), []);
  assert.deepEqual(spentSelections([selection()], [{ ...voided, status: "Live" }], "2026-10-28T15:00:00Z"), []);
  // The modal's opener stays the plain button unless a rate is spent.
  const m = read("apps/ownership-planner/components/SubmitConfirm.tsx");
  assert.match(m, /const refreshFirst = \(confirmation\.spent\?\.length \?\? 0\) > 0 && !held;/);
  assert.match(m, /\{refreshFirst \? \(\s*<PendingButton[\s\S]*?formAction=\{refreshSpentRates\}[\s\S]*?\) : \(\s*<button type="button" className="btn" onClick=\{show\}/);
  // The Edge Function answers not_spent before any rating.
  const rv = read("supabase/functions/fni-rate-vehicle/index.ts");
  assert.ok(rv.indexOf('outcome: "not_spent"') < rv.indexOf("await rateSession(", rv.indexOf("async function refreshSpent(")));
});

test("a rate is spent after a void, until the deal is rated again", () => {
  assert.equal(spentSelections([selection()], [voided], "2026-10-28T15:00:00Z").length, 1);
  assert.equal(spentSelections([selection()], [voided], null).length, 1);
  // Rated after the void, even if the provider kept the same rate ID: not spent.
  assert.equal(spentSelections([selection()], [voided], "2026-10-28T16:05:00Z").length, 0);
  // Another product's void does not spend this one.
  assert.equal(spentSelections([selection()], [{ ...voided, provider_product_id: "TIRE" }], null).length, 0);
});

test("identical prices: the selection moves onto the fresh rate ID", () => {
  const r = compareRefreshed([selection()], families(rate("34347")), families(rate("40001")));
  assert.equal(r.unchanged, true);
  assert.equal(r.lines[0].status, "unchanged");
  assert.equal(r.lines[0].from_rate, "34347");
  assert.equal(r.lines[0].to_rate, "40001");
  assert.deepEqual(r.lines[0].snapshot, { unique: "40001" });
  assert.deepEqual(r.lines[0].old, { dealer_cost: 200, option_cost: 25, customer_price: 425 });
  assert.deepEqual(r.lines[0].new, { dealer_cost: 200, option_cost: 25, customer_price: 425 });
  // The submit then sends the fresh ID: the selection row is what it reads.
  const rv = read("supabase/functions/fni-rate-vehicle/index.ts");
  assert.match(rv, /if \(unchanged\) \{[\s\S]*?\.update\(\{ rate_unique_id: l\.to_rate, rate_snapshot: l\.snapshot \}\)/);
  assert.equal(REFRESHED_NOTE, "The rating was refreshed because an earlier contract was voided. Prices are unchanged.");
});

test("a one-cent difference holds the submit and shows the difference", () => {
  const r = compareRefreshed([selection()], families(rate("34347")), families(rate("40001", { dealer_cost: 200.01, retail_price: 400.01 })));
  assert.equal(r.unchanged, false);
  assert.equal(r.lines[0].status, "changed");
  assert.equal(
    differenceText(r.lines[0], money),
    "Sample Battery: dealer cost $200.00 to $200.01, customer price $425.00 to $425.01."
  );
  // An option cost moving a cent holds it too.
  const opt = compareRefreshed([selection()], families(rate("34347")), families(rate("40001", {
    options: [{ code: "COMM", label: "Commercial", cost_delta: 25.01, mandatory: false, applied: false }],
  })));
  assert.equal(opt.unchanged, false);
  assert.match(differenceText(opt.lines[0], money), /option cost \$25\.00 to \$25\.01/);
  assert.equal(HELD_MESSAGE, "Prices changed since this deal was rated. Review the products on Details before submitting.");
  // Held: nothing moves, and Confirm Submit stays disabled.
  const m = read("apps/ownership-planner/components/SubmitConfirm.tsx");
  assert.match(m, /disabled=\{!open \|\| !!blocked \|\| !!held \|\|/);
});

test("a product no longer offered holds the submit", () => {
  const term = compareRefreshed([selection()], families(rate("34347")), families(rate("40001", { term_months: 24 })));
  assert.equal(term.unchanged, false);
  assert.equal(term.lines[0].status, "missing");
  assert.equal(differenceText(term.lines[0], money), "Sample Battery: no longer offered.");
  const gone = compareRefreshed([selection()], families(rate("34347")), []);
  assert.equal(gone.lines[0].status, "missing");
  const noOption = compareRefreshed([selection()], families(rate("34347")), families(rate("40001", { options: [] })));
  assert.equal(noOption.lines[0].status, "missing");
});

test("every selection the submit sends is matched, not just the spent one", () => {
  const other = selection({ id: "sel2", provider_product_id: "TIRE", product_name: "Sample Tire", rate_unique_id: "500", selected_options: [], customer_price: 300 });
  const tire = (id, cost) => ({ ...families()[0], family_code: "TIRE", tiers: [{ product_code: "TIRE", product_name: "Sample Tire", product_type: "TIRE", raw: {}, rates: [rate(id, { dealer_cost: cost, retail_price: 300, options: [] })] }] });
  const r = compareRefreshed(
    [selection(), other],
    [...families(rate("34347")), tire("500", 100)],
    [...families(rate("40001")), tire("501", 100)]
  );
  assert.equal(r.unchanged, true);
  assert.deepEqual(r.lines.map((l) => l.to_rate), ["40001", "501"]);
});

test("a re-rate failure shows the provider's error and sends nothing", () => {
  const rv = read("supabase/functions/fni-rate-vehicle/index.ts");
  const fn = rv.slice(rv.indexOf("async function refreshSpent("));
  assert.match(fn, /if \(!ta \|\| ta\.result\.state !== "Rated"\) \{[\s\S]*?outcome: "failed",\s*error: `The rating could not be refreshed, so nothing was submitted\. \$\{reason\}`/);
  // A refresh never submits, and the action never calls the submit.
  assert.doesNotMatch(fn, /fni-contract-submit|submitContract/);
  const actions = read("apps/ownership-planner/app/console-actions.ts");
  const action = actions.slice(actions.indexOf("export async function refreshSpentRates("), actions.indexOf("export async function submitContracts("));
  assert.match(action, /edge\.rate</);
  assert.doesNotMatch(action, /edge\.submit/);
  assert.match(action, /"refreshfailed"/);
  // The rating banner, with Show details and Copy error, holds the provider's words.
  assert.equal(
    flash.flashMessage({ code: "refreshfailed", detail: "x" }, { ratingShown: true }).text,
    "The rating could not be refreshed, so nothing was submitted. The provider's error is below."
  );
  assert.equal(flash.flashMessage({ code: "refreshfailed", detail: "The rating could not be refreshed, so nothing was submitted. Sample fault." }).text,
    "The rating could not be refreshed, so nothing was submitted. Sample fault.");
});

test("no retry loop: a refused submit after a refresh is a refusal, and the next press does not refresh", () => {
  // Rated after the void: nothing is spent, so Submit opens the modal.
  assert.equal(spentSelections([selection({ rate_unique_id: "40001" })], [voided], "2026-10-28T16:05:00Z").length, 0);
  assert.equal(spentSelections([selection()], [voided], "2026-10-28T16:05:00Z").length, 0);
  // The submit itself never re-rates or refreshes.
  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.doesNotMatch(submit, /refresh_spent|refreshSpent|rateSession\(/);
});

test("events are written, by the signed-in initials or System", () => {
  assert.equal(REFRESHED_UNCHANGED_EVENT, "Rating refreshed after a void: prices unchanged");
  assert.equal(REFRESHED_HELD_EVENT, "Rating refreshed after a void: prices changed, submit held");
  const rv = read("supabase/functions/fni-rate-vehicle/index.ts");
  assert.match(rv, /event: unchanged \? REFRESHED_UNCHANGED_EVENT : REFRESHED_HELD_EVENT,/);
  assert.match(rv, /const who = renewedBy\(by\);[\s\S]*?created_by: who,/);
  assert.match(rv, /return await refreshSpent\(supabase, sess, rateSource, body\.refreshed_by\);/);
  assert.match(read("apps/ownership-planner/app/console-actions.ts"), /refresh_spent: true,[\s\S]*?refreshed_by: initialsFor\(operator\.email\),/);
  // A refresh leaves the session's status alone, so the contracts panel stays.
  const fn = rv.slice(rv.indexOf("async function refreshSpent("));
  assert.doesNotMatch(fn.slice(0, fn.indexOf("\n}\n")), /status:/);
});

test("the modal says what the last refresh found, while the selections still stand where it left them", () => {
  const lines = [{ product_name: "Sample Battery", provider_product_id: "BATT-STD", from_rate: "34347", to_rate: "40001", status: "changed",
    old: { dealer_cost: 200, option_cost: 25, customer_price: 425 }, new: { dealer_cost: 200.01, option_cost: 25, customer_price: 425.01 } }];
  const held = { event: REFRESHED_HELD_EVENT, created_at: "2026-10-28T16:05:00Z", detail: { lines } };
  assert.deepEqual(refreshState([{ provider_product_id: "BATT-STD", rate_unique_id: "34347" }], held, money), {
    kind: "held",
    differences: ["Sample Battery: dealer cost $200.00 to $200.01, customer price $425.00 to $425.01."],
  });
  // Re-presented since: the old refresh no longer speaks.
  assert.equal(refreshState([{ provider_product_id: "BATT-STD", rate_unique_id: "40002" }], held, money), null);
  const done = { event: REFRESHED_UNCHANGED_EVENT, created_at: "2026-10-28T16:05:00Z", detail: { lines: [{ ...lines[0], status: "unchanged" }] } };
  assert.deepEqual(refreshState([{ provider_product_id: "BATT-STD", rate_unique_id: "40001" }], done, money), { kind: "refreshed" });
  // The modal's figures stay the submit's own rows (saved-selections.ts).
  assert.match(read("supabase/functions/fni-session-verify/index.ts"), /\.\.\.\(await spentStateFor\(supabase, s, \(data \?\? \[\]\)/);
});

test("the Details wording is the Edge Function's, word for word", () => {
  assert.equal(flash.REFRESHED_NOTE, REFRESHED_NOTE);
  assert.equal(flash.HELD_MESSAGE, HELD_MESSAGE);
  assert.equal(flash.flashMessage({ code: "spentrefreshed", detail: null }).text, REFRESHED_NOTE);
  assert.equal(flash.flashMessage({ code: "spentheld", detail: null }).text, HELD_MESSAGE);
  for (const c of ["submitready", "spentrefreshed", "spentheld"]) assert.ok(flash.SUBMIT_OPEN_CODES.includes(c));
  for (const s of [REFRESHED_NOTE, HELD_MESSAGE, REFRESHED_UNCHANGED_EVENT, REFRESHED_HELD_EVENT]) assert.doesNotMatch(s, /\u2014|DX1/);
});
