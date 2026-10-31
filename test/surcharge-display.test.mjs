// test/surcharge-display.test.mjs
//
// Surcharge names for display (_shared/surcharge-display.ts and its browser
// mirror). Labels as the provider sends them; mock data otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plainLabel, labelProblem } from "../supabase/functions/_shared/surcharge-display.ts";
import { surchargeChoices } from "../supabase/functions/_shared/menu-prepare.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// Every optional surcharge label seen in rated offers (2026-10-31), as sent.
const SEEN = [
  "Add One Battery", "Add Two Batteries", "Add Seven Batteries", "Lithium Battery", "Service Drive Surcharge",
  "Chrome/Aftermarket Wheels", "GPS EQUIPPED", "Commercial Use - All Dealers", "HVAC Equipped",
  "Lift Kit / Oversized Tire - All Dealers", "Snow Removal", "Trailer Package",
];

test("the labels asked for", () => {
  assert.equal(plainLabel("GPS EQUIPPED"), "GPS Equipped");
  assert.equal(plainLabel("Commercial Use - All Dealers"), "Commercial Use");
  assert.equal(plainLabel("Lift Kit / Oversized Tire - All Dealers"), "Lift Kit / Oversized Tire");
  // Already readable: left as the provider spells it.
  assert.equal(plainLabel("HVAC Equipped"), "HVAC Equipped");
  assert.equal(plainLabel("Chrome/Aftermarket Wheels"), "Chrome/Aftermarket Wheels");
  assert.equal(plainLabel("Snow Removal"), "Snow Removal");
});

test("capitals and suffixes in other shapes", () => {
  assert.equal(plainLabel("SNOW PLOW - PARTICIPATING DEALERS"), "Snow Plow");
  assert.equal(plainLabel("LIFT KIT/OVERSIZED TIRE"), "Lift Kit/Oversized Tire");
  assert.equal(plainLabel("4X4 WITH WINCH"), "4X4 with Winch");
  assert.equal(plainLabel("  Trailer   Package - Select Dealer "), "Trailer Package");
});

test("no displayed label is in capitals or carries a dealer suffix", () => {
  const mock = [...SEEN, "SNOW PLOW - ALL DEALERS", "WINCH", "UTV CAB ENCLOSURE", "Heated Grips - Participating Dealers"];
  for (const raw of mock) {
    const shown = plainLabel(raw);
    assert.equal(labelProblem(shown), null, `"${raw}" shows as "${shown}"`);
  }
  // The check itself catches what it is for.
  assert.equal(labelProblem("GPS EQUIPPED"), "in capitals");
  assert.equal(labelProblem("Commercial Use - All Dealers"), "a dealer suffix");
  assert.equal(labelProblem("GPS"), null);
});

test("the Surcharges dialog shows plain labels; the provider's code is kept as sent", () => {
  const families = [{
    family_code: "VSA", provider_id: "p1", provider_name: "Sample",
    tiers: [{ product_code: "VSA-1", product_name: "SAMPLE CARE", product_type: "VSA", provider_id: "p1", raw: {}, rates: [{
      rate_unique_id: "r1", term_months: 24, term_miles: 0, deductible: 0, deductible_code: "0 Ded", disappearing_deductible: false,
      dealer_cost: 300, provider_markup: 0, retail_price: 450,
      options: [
        { code: "COMMERCIAL", label: "Commercial Use - All Dealers", cost_delta: 40, mandatory: false, applied: false },
        { code: "GPS", label: "GPS EQUIPPED", cost_delta: -50, mandatory: false, applied: false },
        { code: "LiftKit-Oversized", label: "Lift Kit / Oversized Tire - All Dealers", cost_delta: 75, mandatory: false, applied: false },
      ],
    }] }],
  }];
  const choices = surchargeChoices(families);
  assert.deepEqual(choices, [
    { code: "COMMERCIAL", label: "Commercial Use" },
    { code: "GPS", label: "GPS Equipped" },
    { code: "LiftKit-Oversized", label: "Lift Kit / Oversized Tire" },
  ]);
  for (const c of choices) assert.equal(labelProblem(c.label), null);
});

test("the customer's product options show plain labels too", () => {
  const view = read("apps/ownership-planner/components/ProductConfigurator.tsx");
  assert.match(view, /<span className="config-label">\{plainLabel\(o\.label\)\}<\/span>/);
  assert.doesNotMatch(view, /\{o\.label\}/);
});

test("the browser's words are the server's", () => {
  const body = (rel) => read(rel).split("/** Kept in capitals")[1];
  assert.equal(body("apps/ownership-planner/lib/surcharge-display.ts"), body("supabase/functions/_shared/surcharge-display.ts"));
});
