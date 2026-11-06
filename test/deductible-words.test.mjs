// The real deductible, in words, everywhere staff or customers see one
// (6 Nov 2026): "$100 disappearing deductible", "$50 deductible", "No
// deductible". Never "-1" or "($1)". Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as shared from "../supabase/functions/_shared/menu-presets.ts";
import * as app from "../apps/ownership-planner/lib/menu-labels.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("one way of saying it, the same on both sides", () => {
  const cases = [
    [[100, true], "$100 disappearing deductible"],
    [[50, false], "$50 deductible"],
    [[100, false], "$100 deductible"],
    [[0, false], "No deductible"],
    [[null, false], "No deductible"],
    [[-1, false], "No deductible"],
    [[-1, true], "No deductible"],
    [["50.00", false], "$50 deductible"],
    [[1000, false], "$1,000 deductible"],
    [[37.5, false], "$37.50 deductible"],
  ];
  for (const [[amount, disappearing], words] of cases) {
    assert.equal(shared.deductibleLabel(amount, disappearing), words, `${amount} ${disappearing}`);
    assert.equal(app.deductibleLabel(amount, disappearing), words, `${amount} ${disappearing}`);
  }
  // Prepare's option names carry it.
  const r = { rate_unique_id: "x", term_months: 24, term_miles: 0, deductible: -1, disappearing_deductible: false };
  assert.equal(shared.optionLabel(r), "2 years / Unlimited miles, No deductible");
  assert.equal(app.optionLabel(r), shared.optionLabel(r));
});

test("every screen uses it: no money() of a deductible, no bare amounts", () => {
  const chooser = read("apps/ownership-planner/components/RateChooser.tsx");
  assert.match(chooser, /function deductibleLabel\(r: OfferRate\): string \{\s*return wordsFor\(r\.deductible, r\.disappearing_deductible\);\s*\}/);
  assert.doesNotMatch(chooser, /"None"/);
  const menu = read("apps/ownership-planner/app/menu/[sessionId]/Menu.tsx");
  assert.match(menu, /offersDeductibles \? deductibleLabel\(rate\.deductible, rate\.disappearing_deductible\) : null,/);
  assert.doesNotMatch(menu, /money\(rate\.deductible\)/);
  const screen = read("apps/ownership-planner/components/ProductScreen.tsx");
  assert.doesNotMatch(screen, /deductibleLine = money\(/);
  assert.match(screen, /if \(chosenRate\?\.disappearing_deductible && deductible !== null && deductible > 0\) \{/);
  assert.match(screen, /if \(!deductibleLine && chosenRate && offersDeductibles\) deductibleLine = deductibleLabel\(deductible, chosenRate\.disappearing_deductible\);/);
});
