// Where a payment comes from, and when there is no payment at all.
//
// Pinned the way the TILA math is pinned, because the fallback chain decides
// what a buyer is told about their own deal. The cash path especially: a cash
// buyer shown a monthly figure is being told something untrue about a purchase
// they are about to sign for.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthlyPayment,
  planTotals,
  resolvePaymentBasis,
  toCents,
} from "../apps/ownership-planner/lib/money.ts";

// The real session: TILA calculated, lienholder Peoples Bank.
const TILA = {
  tilaAmountFinanced: 13930.94,
  amountFinanced: 13800.94,
  apr: 8.5165,
  interestRate: 7.84,
  termMonths: 60,
  lienholderName: "Peoples Bank",
};

// ── 1. TILA calculated ─────────────────────────────────────────────────────

test("TILA wins when it was calculated, and still reproduces the contract", () => {
  const b = resolvePaymentBasis(TILA);
  assert.equal(b.kind, "tila");
  assert.equal(b.principal, 13930.94);
  assert.equal(b.ratePercent, 8.5165);
  assert.equal(b.rateSource, "apr");
  assert.equal(b.rateLabel, "Annual percentage rate");
  assert.equal(b.termMonths, 60);
  assert.equal(b.hasPayment, true);

  // The whole point of preferring TILA: it is the only combination that
  // reproduces the contract payment of 285.93.
  assert.equal(toCents(monthlyPayment(b.principal, b.ratePercent, b.termMonths)), 285.93);
});

test("on the TILA path, APR wins where present and the interest rate otherwise", () => {
  assert.equal(resolvePaymentBasis(TILA).rateSource, "apr");

  const noApr = resolvePaymentBasis({ ...TILA, apr: null });
  assert.equal(noApr.kind, "tila");
  assert.equal(noApr.ratePercent, 7.84);
  assert.equal(noApr.rateSource, "interest_rate");
  assert.equal(noApr.rateLabel, "Interest rate");
});

// ── 2. No TILA, but financed ───────────────────────────────────────────────

test("a financed deal without TILA falls back to the balance due", () => {
  // TILA only runs when a lienholder needs it, so its absence here is normal.
  const b = resolvePaymentBasis({ ...TILA, tilaAmountFinanced: null, apr: null });
  assert.equal(b.kind, "lienholder");
  assert.equal(b.principal, 13800.94);
  assert.equal(b.ratePercent, 7.84);
  assert.equal(b.rateSource, "interest_rate");
  assert.equal(b.termMonths, 60);
  assert.equal(b.hasPayment, true);

  assert.equal(toCents(monthlyPayment(b.principal, b.ratePercent, b.termMonths)), 278.78);
});

test("the fallback uses the interest rate even when an APR is lying around", () => {
  // Without TILA there is no TILA_APR, so an apr value on the row is not the
  // lender's. The deal's own interest rate is what the balance due is carried at.
  const b = resolvePaymentBasis({ ...TILA, tilaAmountFinanced: null });
  assert.equal(b.kind, "lienholder");
  assert.equal(b.ratePercent, 7.84);
  assert.equal(b.rateSource, "interest_rate");
});

test("a zero-percent financed deal is a real deal, not a missing rate", () => {
  const b = resolvePaymentBasis({
    ...TILA, tilaAmountFinanced: null, apr: null, interestRate: 0,
  });
  assert.equal(b.kind, "lienholder");
  assert.equal(b.ratePercent, 0);
  assert.equal(b.hasPayment, true);
  assert.equal(toCents(monthlyPayment(b.principal, 0, b.termMonths)), 230.02);
});

// ── 3. Cash ────────────────────────────────────────────────────────────────

test("no lienholder means cash, and cash means no payment", () => {
  for (const blank of [null, undefined, "", "   "]) {
    const b = resolvePaymentBasis({ ...TILA, lienholderName: blank });
    assert.equal(b.kind, "cash");
    assert.equal(b.hasPayment, false);
    assert.equal(b.principal, null);
    assert.equal(b.ratePercent, null);
    assert.equal(b.termMonths, null);
    assert.equal(b.rateLabel, null);
  }
});

test("cash wins even when the financing columns still carry leftovers", () => {
  // The decisive check. Every TILA figure is present and perfectly usable here;
  // the deal is still a cash purchase, and amortizing those leftovers would put
  // a monthly payment on a purchase that has none.
  const b = resolvePaymentBasis({ ...TILA, lienholderName: null });
  assert.equal(b.kind, "cash");
  assert.equal(b.hasPayment, false);
  assert.equal(b.principal, null, "a cash deal must not carry a principal through");
});

test("a cash plan is a total, not a payment", () => {
  const b = resolvePaymentBasis({ ...TILA, lienholderName: "" });
  assert.equal(b.hasPayment, false);

  // The plan still has a price. It is simply added to the purchase rather than
  // to a payment, so the only figure the interface may show is the sum.
  const prices = [2225, 890];
  assert.equal(toCents(prices.reduce((a, p) => a + p, 0)), 3115);
});

// ── Financed but incomplete ────────────────────────────────────────────────

test("a financed deal missing its inputs is not quietly called a cash deal", () => {
  const b = resolvePaymentBasis({
    ...TILA, tilaAmountFinanced: null, amountFinanced: null, termMonths: null,
  });
  assert.equal(b.kind, "unavailable");
  assert.notEqual(b.kind, "cash", "telling a financed buyer this is cash misstates the sale");
  assert.equal(b.hasPayment, false);
});

test("an incomplete financed deal still reports the figures it does have", () => {
  const b = resolvePaymentBasis({ ...TILA, termMonths: null });
  assert.equal(b.kind, "unavailable");
  assert.equal(b.principal, 13930.94);
  assert.equal(b.ratePercent, 8.5165);
  assert.equal(b.termMonths, null);
  assert.equal(b.hasPayment, false);
});

test("a zero or negative term never produces a payment", () => {
  for (const term of [0, -12, Number.NaN]) {
    const b = resolvePaymentBasis({ ...TILA, termMonths: term });
    assert.equal(b.hasPayment, false);
    assert.equal(b.kind, "unavailable");
  }
});

// ── The three paths, side by side ──────────────────────────────────────────

test("the same products cost the same money on every path", () => {
  const prices = [2225, 890];
  const productTotal = 3115;

  const tila = resolvePaymentBasis(TILA);
  const fallback = resolvePaymentBasis({ ...TILA, tilaAmountFinanced: null });
  const cash = resolvePaymentBasis({ ...TILA, lienholderName: null });

  assert.equal(
    planTotals(tila.principal, prices, tila.ratePercent, tila.termMonths).productTotal,
    productTotal
  );
  assert.equal(
    planTotals(fallback.principal, prices, fallback.ratePercent, fallback.termMonths).productTotal,
    productTotal
  );

  // Only the monthly framing differs, and on cash there is none to differ.
  assert.equal(tila.hasPayment, true);
  assert.equal(fallback.hasPayment, true);
  assert.equal(cash.hasPayment, false);
});
