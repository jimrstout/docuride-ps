// Payment math for the Ownership Planner.
//
// The anchor case is a real deal: fni session 44e41c35, a 2020 Can-Am Spyder RT
// financed through Peoples Bank. Every number below is what Zoho actually holds
// for it. If this test drifts, the planner is quoting a payment no lender agreed
// to, shown to a customer who will reasonably believe it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthlyPayment,
  planTotals,
  productPayment,
  selectRate,
  toCents,
} from "../apps/ownership-planner/lib/money.ts";

// The live record, verbatim.
const DEAL = {
  Sold_1_Vehicle_DSP: 16023.79,
  DC_Sold_1_Balance_Due: 13800.94,
  TILA_Amount_Financed: 13930.94,
  Interest_Rate: 7.84,
  TILA_APR: 8.5165,
  Term_Months: 60,
  TILA_Pmt1_Count: 59,
  TILA_Pmt1_Amount: 285.93,
  TILA_Pmt2_Count: 1,
  TILA_Pmt2_Amount: 285.6,
  TILA_Finance_Charge: 3224.53,
};

test("reproduces the contract payment exactly", () => {
  const p = monthlyPayment(DEAL.TILA_Amount_Financed, DEAL.TILA_APR, DEAL.Term_Months);
  assert.equal(toCents(p), DEAL.TILA_Pmt1_Amount);
});

test("the contract's own totals reconcile, both ways", () => {
  const scheduled =
    DEAL.TILA_Pmt1_Count * DEAL.TILA_Pmt1_Amount +
    DEAL.TILA_Pmt2_Count * DEAL.TILA_Pmt2_Amount;
  const fromTila = DEAL.TILA_Amount_Financed + DEAL.TILA_Finance_Charge;
  assert.equal(toCents(scheduled), toCents(fromTila));
  assert.equal(toCents(scheduled), 17155.47);
});

// These three guard the corrections in SPEC_CORRECTIONS.md §1. Each asserts the
// WRONG input produces a visibly wrong payment, so nobody quietly reverts to it.
test("the balance due is not the principal", () => {
  const wrong = monthlyPayment(DEAL.DC_Sold_1_Balance_Due, DEAL.TILA_APR, DEAL.Term_Months);
  assert.notEqual(toCents(wrong), DEAL.TILA_Pmt1_Amount);
  assert.equal(toCents(DEAL.TILA_Pmt1_Amount - toCents(wrong)), 2.67);
});

test("the first payment stream's count is not the term", () => {
  // TILA_Pmt1_Count is 59 because the 60th payment is a different amount.
  const wrong = monthlyPayment(DEAL.TILA_Amount_Financed, DEAL.TILA_APR, DEAL.TILA_Pmt1_Count);
  assert.equal(toCents(wrong), 289.82);
  assert.equal(DEAL.TILA_Pmt1_Count + DEAL.TILA_Pmt2_Count, DEAL.Term_Months);
});

test("the interest rate is not the APR", () => {
  const wrong = monthlyPayment(DEAL.TILA_Amount_Financed, DEAL.Interest_Rate, DEAL.Term_Months);
  assert.notEqual(toCents(wrong), DEAL.TILA_Pmt1_Amount);
});

test("APR wins when present, and names itself honestly", () => {
  const withApr = selectRate(DEAL.TILA_APR, DEAL.Interest_Rate);
  assert.equal(withApr.ratePercent, DEAL.TILA_APR);
  assert.equal(withApr.source, "apr");
  assert.equal(withApr.label, "Annual percentage rate");

  const withoutApr = selectRate(null, DEAL.Interest_Rate);
  assert.equal(withoutApr.ratePercent, DEAL.Interest_Rate);
  assert.equal(withoutApr.label, "Interest rate");

  assert.equal(selectRate(null, null), null);
  // A 0% promotional rate is a real rate, not a missing one.
  assert.equal(selectRate(0, 7.84).ratePercent, 0);
});

test("a zero rate divides evenly instead of dividing by zero", () => {
  assert.equal(toCents(monthlyPayment(12000, 0, 60)), 200);
});

test("totals come from the combined principal, not summed rounded deltas", () => {
  // Prices chosen so the per-product roundings all sit just under a half cent;
  // summing them drifts away from what the contract will say.
  const prices = [1349.37, 199.41, 612.83];
  const t = planTotals(DEAL.TILA_Amount_Financed, prices, DEAL.TILA_APR, DEAL.Term_Months);

  const summedDeltas = prices.reduce(
    (a, p) => a + productPayment(p, DEAL.TILA_APR, DEAL.Term_Months),
    0
  );

  assert.equal(t.productTotal, 2161.61);
  assert.equal(
    t.totalPayment,
    toCents(monthlyPayment(DEAL.TILA_Amount_Financed + 2161.61, DEAL.TILA_APR, DEAL.Term_Months))
  );
  // Summing each product's own rounded payment lands somewhere else entirely.
  assert.notEqual(toCents(summedDeltas), t.planPayment);
});

test("the breakdown on screen always adds up to the total on screen", () => {
  // This case is a rounding boundary: the vehicle payment rounds up and the
  // true incremental cost rounds up too, which would print 285.93 + 44.37
  // beside a total of 330.29. The plan line absorbs the rounding instead, so
  // the column reconciles.
  const t = planTotals(DEAL.TILA_Amount_Financed, [1349.37, 199.41, 612.83], DEAL.TILA_APR, DEAL.Term_Months);
  assert.equal(t.vehiclePayment, 285.93);
  assert.equal(t.totalPayment, 330.29);
  assert.equal(t.planPayment, 44.36);
  assert.equal(toCents(t.vehiclePayment + t.planPayment), t.totalPayment);
});

test("the breakdown reconciles across a wide sweep of plans", () => {
  const prices = [1349.37, 199.41, 612.83, 845.05, 1099.99, 74.5];
  for (let mask = 0; mask < 1 << prices.length; mask++) {
    const chosen = prices.filter((_, i) => mask & (1 << i));
    for (const term of [24, 36, 48, 60, 72, 84]) {
      for (const rate of [0, 3.99, 7.84, 8.5165, 12.25, 21.9]) {
        const t = planTotals(DEAL.TILA_Amount_Financed, chosen, rate, term);
        assert.equal(
          toCents(t.vehiclePayment + t.planPayment),
          t.totalPayment,
          `did not reconcile at mask=${mask} term=${term} rate=${rate}`
        );
      }
    }
  }
});

test("an empty plan costs nothing and still reports the vehicle payment", () => {
  const t = planTotals(DEAL.TILA_Amount_Financed, [], DEAL.TILA_APR, DEAL.Term_Months);
  assert.equal(t.productTotal, 0);
  assert.equal(t.planPayment, 0);
  assert.equal(t.totalPayment, DEAL.TILA_Pmt1_Amount);
  assert.equal(t.vehiclePayment, DEAL.TILA_Pmt1_Amount);
});

test("money rounds where a human would, not where binary floats land", () => {
  assert.equal(toCents(2.675), 2.68);
  assert.equal(toCents(1.005), 1.01);
});
