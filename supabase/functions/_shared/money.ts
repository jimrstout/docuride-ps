// _shared/money.ts
//
// Canonical payment math for the Ownership Planner.
//
// This file is mirrored byte-for-byte between the marker comments into
// apps/ownership-planner/lib/money.ts, because the Deno side needs it to render
// the acknowledgment document and the browser needs it to recompute payments as
// the customer changes their mind. test/money-parity.test.mjs fails the build if
// the two drift.
//
// If it's off a penny, it's a bug. Never round to "close enough".

// ─── SHARED BLOCK START ──────────────────────────────────────────────────

export interface RateBasis {
  /** The rate actually used, as a percent (8.5165 means 8.5165%). */
  ratePercent: number;
  /** Which Zoho value it came from, so the interface can label it honestly. */
  source: "apr" | "interest_rate";
  /** The label to print. Never print one over the other's value. */
  label: string;
}

/**
 * Pick the rate to amortize with.
 *
 * Default to the interest rate; use APR when the record carries one. The two
 * genuinely differ on real deals (7.84 vs 8.5165 on the first live record) and
 * the difference moves the payment, so the choice is recorded rather than
 * assumed, and the caller labels the field with whichever was used.
 */
export function selectRate(
  apr: number | null | undefined,
  interestRate: number | null | undefined
): RateBasis | null {
  if (apr !== null && apr !== undefined && Number.isFinite(apr)) {
    return { ratePercent: apr, source: "apr", label: "Annual percentage rate" };
  }
  if (
    interestRate !== null &&
    interestRate !== undefined &&
    Number.isFinite(interestRate)
  ) {
    return {
      ratePercent: interestRate,
      source: "interest_rate",
      label: "Interest rate",
    };
  }
  return null;
}

/**
 * Standard amortization. Returns the unrounded payment; round only at display.
 */
export function monthlyPayment(
  principal: number,
  annualRatePercent: number,
  months: number
): number {
  if (!(months > 0)) return 0;
  const r = annualRatePercent / 100 / 12;
  if (r === 0) return principal / months;
  const g = Math.pow(1 + r, months);
  return (principal * r * g) / (g - 1);
}

/**
 * Round half-up to cents. JavaScript's Math.round is half-up on positives but
 * binary floating point puts values like 2.675 just under the midpoint, so the
 * epsilon nudge keeps money rounding where a human would put it.
 */
export function toCents(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface PlanTotals {
  /** Payment on the vehicle alone, before any protection. */
  vehiclePayment: number;
  /** Difference between the total payment and the vehicle payment. */
  planPayment: number;
  /** Payment on principal plus every included product. */
  totalPayment: number;
  /** Sum of the included products' prices. */
  productTotal: number;
}

/**
 * Payment impact of a plan.
 *
 * The total is computed from the combined principal, NOT by summing rounded
 * per-product deltas. Summing rounded parts drifts a few cents away from the
 * contract, and a plan summary that does not reconcile against the contract is
 * worse than no summary.
 */
export function planTotals(
  principal: number,
  includedPrices: number[],
  annualRatePercent: number,
  months: number
): PlanTotals {
  const productTotal = includedPrices.reduce((a, p) => a + p, 0);
  const vehiclePayment = monthlyPayment(principal, annualRatePercent, months);
  const totalPayment = monthlyPayment(
    principal + productTotal,
    annualRatePercent,
    months
  );
  return {
    vehiclePayment: toCents(vehiclePayment),
    planPayment: toCents(totalPayment - vehiclePayment),
    totalPayment: toCents(totalPayment),
    productTotal: toCents(productTotal),
  };
}

/**
 * A single product's payment impact, for display next to the product.
 *
 * This is the product financed on its own. It is shown alongside the total
 * price and the coverage duration, never as a bare monthly figure -- a customer
 * who sees "$12/month" without a term cannot see that it is $720 over 60 months.
 */
export function productPayment(
  price: number,
  annualRatePercent: number,
  months: number
): number {
  return toCents(monthlyPayment(price, annualRatePercent, months));
}

/** Format cents as US currency, always with both decimal places. */
export function money(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ─── SHARED BLOCK END ────────────────────────────────────────────────────
