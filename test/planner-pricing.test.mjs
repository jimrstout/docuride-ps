// Cost-banded markup.
//
// The spec's own example is the test: 250% on a $199 contract is defensible,
// because a predictable share of store profit gets spent on customer
// satisfaction issues outside strict plan coverage. The same 250% on a $1,349
// vehicle service contract produces an unsellable and unjustifiable number.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priceProduct,
  resolveRule,
  roundTo,
} from "../supabase/functions/_shared/planner-pricing.ts";

const TENANT = "t1";
const STORE = "s1";

function rule(o) {
  return {
    id: o.id,
    tenant_id: TENANT,
    store_id: o.store_id ?? null,
    product_code: o.product_code ?? null,
    cost_floor: o.cost_floor,
    cost_ceiling: o.cost_ceiling,
    markup_percent: o.markup_percent,
    markup_max_dollars: o.markup_max_dollars ?? null,
    markup_min_dollars: o.markup_min_dollars ?? 0,
    round_to: o.round_to ?? 5,
    active: o.active ?? true,
  };
}

// A plausible store band set: aggressive percentage on cheap products, capped
// in dollars so it cannot run away on expensive ones.
const BANDS = [
  rule({ id: "low", store_id: STORE, cost_floor: 0, cost_ceiling: 400, markup_percent: 250, markup_max_dollars: 600, markup_min_dollars: 75 }),
  rule({ id: "mid", store_id: STORE, cost_floor: 400, cost_ceiling: 900, markup_percent: 120, markup_max_dollars: 800 }),
  rule({ id: "high", store_id: STORE, cost_floor: 900, cost_ceiling: 5000, markup_percent: 65, markup_max_dollars: 900 }),
];

test("250% on a cheap contract is allowed to be 250%", () => {
  // 199 + min(199*2.5 = 497.50, 600) = 696.50 -> rounds to 695
  const r = priceProduct(BANDS, "TIRE", 199);
  assert.equal(r.retail_price, 695);
  assert.equal(r.rule_id, "low");
});

test("a 250% markup on an expensive contract never happens", () => {
  // The same 250% that is fine at $199 would put a $1,349 VSC at $4,721.50.
  // The high band's 65% is what actually applies, and the dollar ceiling caps
  // even that: 1349 + min(876.85, 900) = 2225.85 -> 2225.
  const r = priceProduct(BANDS, "VSC", 1349);
  assert.equal(r.rule_id, "high");
  assert.equal(r.retail_price, 2225);
  assert.ok(r.retail_price < 1349 * 3.5);
});

test("the dollar ceiling binds once the percentage would exceed it", () => {
  // 65% of 2000 is 1300, which the 900 ceiling cuts down.
  const r = priceProduct(BANDS, "VSC", 2000);
  assert.equal(r.retail_price, 2900);
  assert.equal(r.retail_price, 2000 + 900);

  // Just below the point where the cap starts binding, the percentage governs.
  const under = priceProduct(BANDS, "VSC", 1000);
  assert.equal(under.retail_price, 1650); // 1000 + 650
});

test("the dollar floor protects a nearly-free product", () => {
  // 10 + max(min(25, 600), 75) = 85
  assert.equal(priceProduct(BANDS, "KEY", 10).retail_price, 85);
});

test("bands are half-open, so a boundary cost matches exactly one band", () => {
  assert.equal(resolveRule(BANDS, "X", 400).id, "mid");
  assert.equal(resolveRule(BANDS, "X", 399.99).id, "low");
  assert.equal(resolveRule(BANDS, "X", 900).id, "high");
});

test("resolution runs store-specific, then store catch-all, then tenant default", () => {
  const rules = [
    rule({ id: "tenant-catchall", cost_floor: 0, cost_ceiling: 5000, markup_percent: 50 }),
    rule({ id: "tenant-gap", product_code: "GAP", cost_floor: 0, cost_ceiling: 5000, markup_percent: 60 }),
    rule({ id: "store-catchall", store_id: STORE, cost_floor: 0, cost_ceiling: 5000, markup_percent: 70 }),
    rule({ id: "store-gap", store_id: STORE, product_code: "GAP", cost_floor: 0, cost_ceiling: 5000, markup_percent: 80 }),
  ];
  assert.equal(resolveRule(rules, "GAP", 300).id, "store-gap");
  assert.equal(resolveRule(rules, "VSC", 300).id, "store-catchall");

  const noStore = rules.filter((r) => r.store_id === null);
  assert.equal(resolveRule(noStore, "GAP", 300).id, "tenant-gap");
  assert.equal(resolveRule(noStore, "VSC", 300).id, "tenant-catchall");
});

test("the narrowest band wins when two at the same tier overlap", () => {
  const rules = [
    rule({ id: "wide", store_id: STORE, cost_floor: 0, cost_ceiling: 5000, markup_percent: 50 }),
    rule({ id: "narrow", store_id: STORE, cost_floor: 100, cost_ceiling: 300, markup_percent: 90 }),
  ];
  assert.equal(resolveRule(rules, "X", 200).id, "narrow");
  assert.equal(resolveRule(rules, "X", 900).id, "wide");
});

test("an inactive band is not used", () => {
  const rules = [rule({ id: "off", store_id: STORE, cost_floor: 0, cost_ceiling: 5000, markup_percent: 50, active: false })];
  assert.equal(resolveRule(rules, "X", 200), null);
});

// A self-guided session has no F&I manager to catch a bad number, so an
// unpriceable product must come back unpriced rather than guessed. The UI
// refuses to present it.
test("no covering band yields no price, not a guess", () => {
  const r = priceProduct(BANDS, "VSC", 99999);
  assert.equal(r.rule_id, null);
  assert.match(r.unpriced_reason, /No pricing band covers/);
});

test("a missing dealer cost yields no price", () => {
  for (const bad of [null, undefined, NaN, -5]) {
    const r = priceProduct(BANDS, "VSC", bad);
    assert.equal(r.rule_id, null);
    assert.ok(r.unpriced_reason);
  }
});

test("a zero-cost product still prices, at the floor", () => {
  assert.equal(priceProduct(BANDS, "FREE", 0).retail_price, 75);
});

test("rounding lands on the configured step", () => {
  assert.equal(roundTo(696.5, 5), 695);
  assert.equal(roundTo(697.5, 5), 700);
  assert.equal(roundTo(123.456, 0), 123.46);
  assert.equal(roundTo(123.456, 1), 123);
});
