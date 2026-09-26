// Filling a customer-facing sentence, or refusing to.
//
// The disappearing deductible line names the dealer group and states an amount.
// Neither is known at build time, and the amount comes off the chosen rate, so
// the sentence is a template. These tests exist for one rule above all: a
// sentence that cannot be completed is dropped, never shown with a hole in it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_PLACEHOLDERS,
  TEMPLATE_KEYS,
  placeholdersIn,
  renderTemplate,
  resolveTemplates,
  validateTemplate,
} from "../supabase/functions/_shared/copy-templates.ts";

const KEY = TEMPLATE_KEYS.disappearingDeductible;

/** The platform default, as migration 0012 seeds it. */
const DEFAULT =
  "Your {deductible_amount} deductible drops to $0 as long as the repair is done at any {dealer_group_name} store.";

test("the default template reads as a whole sentence once filled", () => {
  assert.equal(
    renderTemplate(DEFAULT, { deductible_amount: "$100", dealer_group_name: "ASP Group" }),
    "Your $100 deductible drops to $0 as long as the repair is done at any ASP Group store."
  );
});

test("the amount is never written into the sentence", () => {
  // The whole point: change the rate, and the sentence follows.
  const fifty = renderTemplate(DEFAULT, { deductible_amount: "$50", dealer_group_name: "ASP Group" });
  assert.ok(fifty.includes("$50"));
  assert.ok(!fifty.includes("$100"));
});

test("no dealer group name means no sentence at all", () => {
  // Rather than "at any  store", or worse "at any {dealer_group_name} store".
  for (const name of [null, undefined, "", "   "]) {
    assert.equal(
      renderTemplate(DEFAULT, { deductible_amount: "$100", dealer_group_name: name }),
      null
    );
  }
});

test("no deductible amount means no sentence either", () => {
  assert.equal(renderTemplate(DEFAULT, { dealer_group_name: "ASP Group" }), null);
});

test("an empty or missing template renders nothing", () => {
  for (const body of [null, undefined, "", "   "]) {
    assert.equal(renderTemplate(body, { dealer_group_name: "ASP Group" }), null);
  }
});

test("a template with no placeholders renders as written", () => {
  // A dealer group whose terms are narrower may not need either value.
  assert.equal(
    renderTemplate("Your deductible is waived at the selling store.", {}),
    "Your deductible is waived at the selling store."
  );
});

test("values are trimmed on the way in", () => {
  assert.equal(
    renderTemplate("at any {dealer_group_name} store", { dealer_group_name: "  ASP Group  " }),
    "at any ASP Group store"
  );
});

test("a placeholder used twice is filled twice", () => {
  assert.equal(
    renderTemplate("{dealer_group_name} and {dealer_group_name}", { dealer_group_name: "ASP" }),
    "ASP and ASP"
  );
});

// ── Validation, at the point of editing ──────────────────────────────────

test("the default template is valid", () => {
  assert.deepEqual(validateTemplate(KEY, DEFAULT), []);
});

test("a placeholder the sentence does not have is refused", () => {
  // {dealer_group} instead of {dealer_group_name} would otherwise reach a buyer
  // as a literal brace.
  const problems = validateTemplate(KEY, "at any {dealer_group} store");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].placeholder, "dealer_group");
});

test("only these two placeholders are offered", () => {
  assert.deepEqual([...ALLOWED_PLACEHOLDERS[KEY]].sort(), [
    "dealer_group_name",
    "deductible_amount",
  ]);
});

test("placeholders are listed once, in order", () => {
  assert.deepEqual(
    placeholdersIn("{b} then {a} then {b}"),
    ["b", "a"]
  );
});

test("an unregistered key is not second-guessed", () => {
  // Inventing a placeholder rule for a template nobody has defined would only
  // be wrong later.
  assert.deepEqual(validateTemplate("something.else", "{whatever}"), []);
});

// ── Which wording is in force ────────────────────────────────────────────

test("a tenant row beats the platform default", () => {
  const inForce = resolveTemplates([
    { tenant_id: null, template_key: KEY, body: DEFAULT },
    { tenant_id: "t1", template_key: KEY, body: "Selling store only." },
  ]);
  assert.equal(inForce.get(KEY), "Selling store only.");
});

test("the platform default applies when the tenant has no row", () => {
  const inForce = resolveTemplates([{ tenant_id: null, template_key: KEY, body: DEFAULT }]);
  assert.equal(inForce.get(KEY), DEFAULT);
});

test("the seeded default is plain English with no em dash", () => {
  assert.ok(!DEFAULT.includes("—"));
  assert.ok(!DEFAULT.includes("–"));
});
