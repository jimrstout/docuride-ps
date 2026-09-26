// lib/copy.ts -- the browser's half of the customer-facing wording.
//
// Two things are checked here, and the first matters more than it looks.
//
// renderTemplate exists twice on purpose: once in the Edge Function, which
// renders the preview an administrator reads on /settings, and once in the
// browser, which renders the line a buyer actually reads. If the two ever
// disagree, the preview stops being a preview and starts being a claim about
// wording that never appears. So every case below is asserted against BOTH
// implementations, and the assertion is that they agree.
//
// durationOf is the other half: how long a cover lasts, in the buyer's words.
// It is shared between the product screen and the plan summary so the page a
// customer takes home cannot state a different term from the screen they
// pressed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderTemplate as client, durationOf } from "../apps/ownership-planner/lib/copy.ts";
import { renderTemplate as server } from "../supabase/functions/_shared/copy-templates.ts";

const DEFAULT =
  "Your {deductible_amount} deductible drops to $0 as long as the repair is done at any {dealer_group_name} store.";

/** Assert both implementations return the same thing, and return it. */
function both(body, values) {
  const a = client(body, values);
  const b = server(body, values);
  assert.deepEqual(a, b, "the browser and the Edge Function rendered differently");
  return a;
}

// ── The two renderers agree ───────────────────────────────────────────────

test("the seeded default fills in identically on both sides", () => {
  assert.equal(
    both(DEFAULT, { deductible_amount: "$100.00", dealer_group_name: "ASP Group" }),
    "Your $100.00 deductible drops to $0 as long as the repair is done at any ASP Group store."
  );
});

test("both drop the sentence when the group name is unset", () => {
  assert.equal(both(DEFAULT, { deductible_amount: "$100.00", dealer_group_name: null }), null);
});

test("both drop the sentence when the group name is only whitespace", () => {
  assert.equal(both(DEFAULT, { deductible_amount: "$100.00", dealer_group_name: "   " }), null);
});

test("both drop the sentence when the amount is missing", () => {
  assert.equal(both(DEFAULT, { dealer_group_name: "ASP Group" }), null);
});

test("both return null for an empty or absent template body", () => {
  assert.equal(both("", { dealer_group_name: "ASP Group" }), null);
  assert.equal(both(undefined, { dealer_group_name: "ASP Group" }), null);
  assert.equal(both(null, { dealer_group_name: "ASP Group" }), null);
});

test("both render a template with no placeholders unchanged", () => {
  assert.equal(both("No deductible on this plan.", {}), "No deductible on this plan.");
});

test("both trim the value rather than pasting the padding in", () => {
  assert.equal(both("At any {dealer_group_name} store.", { dealer_group_name: "  ASP Group " }),
    "At any ASP Group store.");
});

test("both fill every occurrence of a repeated placeholder", () => {
  assert.equal(
    both("{dealer_group_name} service, at any {dealer_group_name} store.", {
      dealer_group_name: "ASP Group",
    }),
    "ASP Group service, at any ASP Group store."
  );
});

// ── How long it lasts ─────────────────────────────────────────────────────

test("whole years read as years", () => {
  assert.equal(durationOf({ term_months: 36, term_miles: 0 }, null), "3 years");
  assert.equal(durationOf({ term_months: 60, term_miles: 0 }, null), "5 years");
});

test("twelve months is one year, singular", () => {
  assert.equal(durationOf({ term_months: 12, term_miles: 0 }, null), "1 year");
});

test("a term that is not whole years stays in months", () => {
  assert.equal(durationOf({ term_months: 18, term_miles: 0 }, null), "18 months");
});

test("zero miles is left out rather than printed", () => {
  // Every powersports rate TecAssured returns carries termMiles 0, so this is
  // the normal case, not an edge case.
  assert.equal(durationOf({ term_months: 48, term_miles: 0 }, null), "4 years");
  assert.equal(durationOf({ term_months: 48, term_miles: null }, null), "4 years");
});

test("real mileage is appended", () => {
  assert.equal(
    durationOf({ term_months: 36, term_miles: 45000 }, null),
    "3 years or 45,000 miles"
  );
});

test("the chosen rate beats the catalog's static line", () => {
  assert.equal(durationOf({ term_months: 60, term_miles: 0 }, "Covers 36 months"), "5 years");
});

test("the catalog line is the fallback when the rate carries no term", () => {
  assert.equal(durationOf({ term_months: null, term_miles: 0 }, "Covers 36 months"),
    "Covers 36 months");
  assert.equal(durationOf(undefined, "Covers 36 months"), "Covers 36 months");
});

test("no rate and no catalog line means no line at all", () => {
  assert.equal(durationOf(undefined, null), null);
  assert.equal(durationOf({ term_months: 0, term_miles: 0 }, null), null);
});
