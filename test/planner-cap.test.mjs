// The finance company's maximum amount financed, in the planner and the save.
//
// With no maximum, every figure is exactly what it was. With one, nothing past
// it is financed: the excess becomes an additional down payment. The planner
// and fni-session-save work that out with the same shared arithmetic, and the
// save prices the selections itself rather than trusting the browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  additionalDownPayment,
  monthlyPayment,
  planTotals,
  productDownImpact,
  toCents,
} from "../apps/ownership-planner/lib/money.ts";
import * as sharedMoney from "../supabase/functions/_shared/money.ts";
import {
  additionalDownForSelections,
  customerPriceFor,
  sessionCap,
  sessionPaymentBasis,
} from "../supabase/functions/_shared/plan-prices.ts";

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

// Deal 13759: $27,547.64 over 60 months at 6.99%.
const P = 27547.64;
const RATE = 6.99;
const TERM = 60;
const PRICES = [1349.37, 199.41, 612.83];

// ── planTotals ──────────────────────────────────────────────────────────────

test("no cap: the existing figures are unchanged", () => {
  const before = planTotals(P, PRICES, RATE, TERM);
  const nullCap = planTotals(P, PRICES, RATE, TERM, null);
  for (const k of ["vehiclePayment", "planPayment", "totalPayment", "productTotal"]) {
    assert.equal(nullCap[k], before[k], k);
  }
  // And they are the plain amortization of the full amounts.
  assert.equal(before.vehiclePayment, toCents(monthlyPayment(P, RATE, TERM)));
  assert.equal(before.totalPayment, toCents(monthlyPayment(P + before.productTotal, RATE, TERM)));
  assert.equal(before.additionalDown, 0);
  assert.equal(before.financedTotal, toCents(P + before.productTotal));
});

test("under the cap: the same as no cap", () => {
  const uncapped = planTotals(P, PRICES, RATE, TERM);
  const capped = planTotals(P, PRICES, RATE, TERM, 40000);
  assert.deepEqual(capped, uncapped);
});

test("over the cap: financed is held to the cap, the rest is down", () => {
  const cap = 29000;
  const t = planTotals(P, PRICES, RATE, TERM, cap);
  // 27,547.64 + 2,161.61 = 29,709.25, which is 709.25 past 29,000.
  assert.equal(t.productTotal, 2161.61);
  assert.equal(t.financedTotal, cap);
  assert.equal(t.additionalDown, 709.25);
  assert.equal(t.totalPayment, toCents(monthlyPayment(cap, RATE, TERM)));
  // The vehicle alone is under the cap, so its payment is unchanged.
  assert.equal(t.vehiclePayment, planTotals(P, [], RATE, TERM).vehiclePayment);
});

test("base already over the cap: additional down before any product", () => {
  const cap = 27000;
  const t = planTotals(P, [], RATE, TERM, cap);
  assert.equal(t.additionalDown, 547.64);
  assert.equal(t.financedTotal, cap);
  assert.equal(t.vehiclePayment, toCents(monthlyPayment(cap, RATE, TERM)));
  assert.equal(t.planPayment, 0);
  // A product then goes wholly to money down.
  assert.equal(planTotals(P, [1000], RATE, TERM, cap).additionalDown, 1547.64);
});

test("the breakdown lines always add up to the total", () => {
  for (const cap of [null, 26000, 27547.64, 28000, 29000, 29709.25, 50000]) {
    for (const chosen of [[], [PRICES[0]], PRICES, [0.01, 999.99, 2500]]) {
      const t = planTotals(P, chosen, RATE, TERM, cap);
      assert.equal(toCents(t.vehiclePayment + t.planPayment), t.totalPayment, `${cap} ${chosen}`);
      // Financed plus down is the whole plan, to the penny.
      assert.equal(toCents(t.financedTotal + t.additionalDown), toCents(P + t.productTotal));
    }
  }
});

// ── One product's effect on money down ────────────────────────────────────

test("a product adds nothing to money down while under the cap", () => {
  assert.equal(productDownImpact(P, [], 1349.37, 40000), 0);
  assert.equal(productDownImpact(P, [1349.37], 199.41, 40000), 0);
  assert.equal(productDownImpact(P, PRICES, 500, null), 0, "no cap");
});

test("a product that crosses the cap adds only the part past it", () => {
  const cap = 29000;
  // 27,547.64 + 1,349.37 = 28,897.01, under. Adding 612.83 reaches 29,509.84.
  assert.equal(productDownImpact(P, [1349.37], 612.83, cap), 509.84);
  // Once already over, each product adds its whole price.
  assert.equal(productDownImpact(P, [1349.37, 612.83], 199.41, cap), 199.41);
  // Consistent with planTotals either way round.
  const without = planTotals(P, [1349.37], RATE, TERM, cap).additionalDown;
  const withIt = planTotals(P, [1349.37, 612.83], RATE, TERM, cap).additionalDown;
  assert.equal(toCents(withIt - without), 509.84);
});

test("the shared arithmetic is the same function on both sides", () => {
  assert.equal(
    sharedMoney.additionalDownPayment(P, 2161.61, 29000),
    additionalDownPayment(P, 2161.61, 29000)
  );
  assert.equal(
    sharedMoney.productDownImpact(P, [1349.37], 612.83, 29000),
    productDownImpact(P, [1349.37], 612.83, 29000)
  );
});

// ── The server's figure matches the planner's ─────────────────────────────

const rate = (id, retail, options = []) => ({
  rate_unique_id: id, term_months: 36, term_miles: 0, deductible: 0,
  deductible_code: null, disappearing_deductible: false,
  dealer_cost: 100, provider_markup: 0, offered_price: null,
  options, raw: {}, retail_price: retail,
});
const opt = (code, delta, mandatory = false) => ({
  code, label: code, cost_delta: delta, mandatory, applied: false,
});
const PRICED = [
  { family_code: "VSC", tiers: [
    { product_code: "VSC-A", product_name: "A", product_type: "VSC", raw: {},
      rates: [rate("a36", 1349.37, [opt("LIFT", 150), opt("COMM", 75, true)]), rate("a48", 1500)] },
  ] },
  { family_code: "TAW", tiers: [
    { product_code: "TAW-1", product_name: "T", product_type: "TAW", raw: {},
      rates: [rate("t1", 612.83)] },
  ] },
];

const session = (over = {}) => ({
  amount_financed: "27547.64", tila_amount_financed: null, apr: null,
  interest_rate: "6.99", finance_term_total: 60,
  lienholder_name: "Roadrunner Financial LLC.", max_amount_financed: "29000",
  ...over,
});

/** What the planner does: its price, then the shared additional down. */
function plannerAdditionalDown(s, picks) {
  const basis = sessionPaymentBasis(s);
  const prices = picks.map(({ product, rateId, chosen }) => {
    const r = PRICED.flatMap((f) => f.tiers).find((t) => t.product_code === product)
      .rates.find((x) => x.rate_unique_id === rateId);
    // The planner's surchargeCost: mandatory options, and the chosen ones.
    const surcharge = r.options
      .filter((o) => o.mandatory || chosen.includes(o.code))
      .reduce((a, o) => a + o.cost_delta, 0);
    return r.retail_price + surcharge;
  });
  const total = toCents(prices.reduce((a, p) => a + p, 0));
  return additionalDownPayment(basis.principal, total, sessionCap(s, basis));
}

test("the save computes the same additional down as the planner", () => {
  const picks = [
    { product: "VSC-A", rateId: "a36", chosen: ["LIFT"] },
    { product: "TAW-1", rateId: "t1", chosen: [] },
  ];
  const selections = picks.map((p) => ({
    provider_product_id: p.product, rate_unique_id: p.rateId, selected_options: p.chosen,
  }));
  const server = additionalDownForSelections(session(), PRICED, selections);
  // 1,349.37 + 150 + 75 (mandatory) + 612.83 = 2,187.20; 27,547.64 + 2,187.20
  // = 29,734.84, which is 734.84 past 29,000.
  assert.deepEqual(server, { value: 734.84, reason: null });
  assert.equal(server.value, plannerAdditionalDown(session(), picks));
  // And the same as planTotals would say on the planner's screen.
  assert.equal(planTotals(27547.64, [1574.37, 612.83], RATE, TERM, 29000).additionalDown, 734.84);
});

test("the save refuses to guess", () => {
  const sel = [{ provider_product_id: "VSC-A", rate_unique_id: "gone", selected_options: [] }];
  assert.equal(additionalDownForSelections(session(), PRICED, sel).value, null);
  assert.equal(customerPriceFor(PRICED, "VSC-A", "gone", []), null);
  // A cash deal has no maximum and no additional down.
  const cash = session({ lienholder_name: null });
  assert.equal(sessionCap(cash, sessionPaymentBasis(cash)), null);
  assert.equal(additionalDownForSelections(cash, PRICED, []).value, null);
  // No maximum: zero, not null.
  assert.equal(additionalDownForSelections(session({ max_amount_financed: null }), PRICED, []).value, 0);
});

test("the planner and the server share one surcharge rule", () => {
  const body = (text, start) => text.slice(text.indexOf(start), text.indexOf("\n}\n", text.indexOf(start)));
  const planner = src("../apps/ownership-planner/app/plan/[sessionId]/Planner.tsx");
  const shared = src("../supabase/functions/_shared/plan-prices.ts");
  const norm = (t) => t.replace(/RateVariant|OfferRate/g, "Rate").replace(/\s+/g, " ");
  assert.equal(
    norm(body(planner, "function surchargeCost(")),
    norm(body(shared, "export function surchargeCost(").replace("export ", ""))
  );
});

test("the save takes no price from the browser", () => {
  const save = src("../supabase/functions/fni-session-save/index.ts");
  const start = save.indexOf("async function serverAdditionalDown(");
  const fn = save.slice(start, save.indexOf("\n}\n", start));
  assert.doesNotMatch(fn, /body\.|decisions|customer_price|retail_price/);
  // Every provider's stored quote, read on the server (0021: one row each).
  assert.match(fn, /offerRowsFor\(supabase, s\.id as string\)/);
  assert.match(fn, /\.from\("pricing_rules"\)/);
  assert.match(fn, /\.eq\("disposition", "Included"\)/);
  assert.match(fn, /o\.out_of_date !== true/);
  assert.match(save, /if \(body\.complete === true\) \{[\s\S]*?patch\.additional_down_payment = down\.value;/);
});

test("fni-session-get sends the figures, and none on a cash deal", () => {
  const get = src("../supabase/functions/fni-session-get/index.ts");
  assert.match(get, /max_amount_financed: cap,/);
  assert.match(get, /agreed_down_payment: num\(s\.agreed_down_payment\),/);
  assert.match(get, /const pricedFamilies = priceFamilies\(families, rules\);/);
  assert.match(src("../supabase/functions/_shared/plan-prices.ts"), /if \(basis\.kind === "cash"\) return null;/);
});

test("the planner never shows the cap, and says it plainly", () => {
  const planner = src("../apps/ownership-planner/app/plan/[sessionId]/Planner.tsx");
  const summary = src("../apps/ownership-planner/components/PaymentSummary.tsx");
  const product = src("../apps/ownership-planner/components/ProductScreen.tsx");
  assert.doesNotMatch(planner + summary + product, /money\(cap\)|max_amount_financed\)\}/);
  assert.match(planner, /planTotals\(principal!, includedPrices, rate!, term!, cap\)/);
  assert.match(summary, /Your finance company approved a set amount\. Your plan goes past it by\{" "\}\s*\{money\(additional\)\}, so that amount is added to your money down\./);
  assert.match(summary, /Agreed down payment/);
  assert.match(summary, /Total due at signing/);
  assert.match(summary, /\(for the protection you have chosen\)/);
  assert.match(product, /Including this adds \{money\(downImpact\)\} to your money down\./);
  // On the payment step, the plan review and the acknowledgment.
  assert.ok((planner.match(/\{downSummary\}/g) ?? []).length >= 5);
  // Nothing on a cash deal.
  assert.match(planner, /const downSummary = isCash \? null :/);
});
