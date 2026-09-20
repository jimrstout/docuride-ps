// lib/money.ts
//
// Canonical payment math for the Ownership Planner.
//
// This file is mirrored byte-for-byte between the marker comments from
// supabase/functions/_shared/money.ts, because the Deno side needs it to render
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
  // Rounded before it is financed, not after. Each product's price is a money
  // amount and the contract will carry it rounded, so the principal has to be
  // built from rounded prices -- otherwise float drift in the sum can move the
  // payment a cent away from what gets signed.
  const productTotal = toCents(includedPrices.reduce((a, p) => a + p, 0));

  // The two anchors: what the customer pays in total, and what the vehicle
  // alone costs. Both are rounded first, and the plan line is then their
  // difference -- so the breakdown on screen always adds up to the total on
  // screen. Rounding each line independently lets 285.93 + 44.37 print beside a
  // total of 330.29, which is a penny out on the one screen the customer takes
  // home, and "close enough" is not a thing money does.
  const vehiclePayment = toCents(monthlyPayment(principal, annualRatePercent, months));
  const totalPayment = toCents(
    monthlyPayment(principal + productTotal, annualRatePercent, months)
  );

  return {
    vehiclePayment,
    planPayment: toCents(totalPayment - vehiclePayment),
    totalPayment,
    productTotal,
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

/**
 * Where a payment comes from on this deal, if one exists at all.
 *
 *   tila         TILA was calculated. The lender's own figures.
 *   lienholder   No TILA, but a lienholder is attached. TILA only runs when a
 *                lienholder needs it, so its absence on a financed deal is
 *                normal rather than an error.
 *   cash         No lienholder. There is no payment, and there is no honest
 *                way to invent one.
 *   unavailable  Financed, but something needed is missing. Deliberately NOT
 *                folded into `cash`: telling a financed buyer their deal is a
 *                cash purchase misrepresents the sale.
 */
export type PaymentBasisKind = "tila" | "lienholder" | "cash" | "unavailable";

export interface PaymentSource {
  /** Zoho TILA_Amount_Financed. Present only when TILA was calculated. */
  tilaAmountFinanced: number | null | undefined;
  /** Zoho DC_Sold_1_Balance_Due. The fallback principal on a financed deal. */
  amountFinanced: number | null | undefined;
  apr: number | null | undefined;
  interestRate: number | null | undefined;
  /** Zoho Term_Months. */
  termMonths: number | null | undefined;
  /**
   * Blank means cash. This is the test the DocuRide record itself uses -- it
   * hides the remaining lienholder fields on the same condition -- so the
   * planner reads the deal the way the record already reads it.
   */
  lienholderName: string | null | undefined;
}

export interface PaymentBasis {
  kind: PaymentBasisKind;
  principal: number | null;
  ratePercent: number | null;
  rateSource: "apr" | "interest_rate" | null;
  rateLabel: string | null;
  termMonths: number | null;
  /**
   * True only when a monthly payment can honestly be shown. Every surface that
   * prints a monthly figure is gated on this, because a cash buyer shown a
   * payment is being told something untrue about their own purchase.
   */
  hasPayment: boolean;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A principal or term of zero is not a usable one. A rate of zero is. */
function positive(v: number | null | undefined): v is number {
  return finite(v) && v > 0;
}

function filled(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Resolve the payment inputs, in the order the deal itself decides.
 *
 * The planner never refuses to open. A deal that cannot produce a payment still
 * has products worth presenting and a decision worth recording -- it just
 * presents totals instead of monthly figures.
 */
export function resolvePaymentBasis(src: PaymentSource): PaymentBasis {
  const none: PaymentBasis = {
    kind: "cash",
    principal: null,
    ratePercent: null,
    rateSource: null,
    rateLabel: null,
    termMonths: null,
    hasPayment: false,
  };

  // No lienholder, no loan. Checked first because it settles the question
  // outright: on a cash deal the financing columns may still carry leftovers,
  // and amortizing them would put a payment on a purchase that has none.
  if (!filled(src.lienholderName)) return none;

  const term = positive(src.termMonths) ? Math.round(src.termMonths) : null;

  // 1. TILA calculated: the lender's own figures, APR where present.
  if (positive(src.tilaAmountFinanced) && term !== null) {
    const rate = selectRate(src.apr, src.interestRate);
    if (rate) {
      return {
        kind: "tila",
        principal: src.tilaAmountFinanced,
        ratePercent: rate.ratePercent,
        rateSource: rate.source,
        rateLabel: rate.label,
        termMonths: term,
        hasPayment: true,
      };
    }
  }

  // 2. No TILA, but financed. The balance due at the deal's own interest rate.
  if (positive(src.amountFinanced) && finite(src.interestRate) && term !== null) {
    return {
      kind: "lienholder",
      principal: src.amountFinanced,
      ratePercent: src.interestRate,
      rateSource: "interest_rate",
      rateLabel: "Interest rate",
      termMonths: term,
      hasPayment: true,
    };
  }

  // Financed, but incomplete. Report what is known so the interface can say
  // which figures it has, and show no payment rather than a guessed one.
  const rate = selectRate(src.apr, src.interestRate);
  return {
    kind: "unavailable",
    principal: positive(src.tilaAmountFinanced)
      ? src.tilaAmountFinanced
      : positive(src.amountFinanced)
        ? src.amountFinanced
        : null,
    ratePercent: rate?.ratePercent ?? null,
    rateSource: rate?.source ?? null,
    rateLabel: rate?.label ?? null,
    termMonths: term,
    hasPayment: false,
  };
}

// ─── SHARED BLOCK END ────────────────────────────────────────────────────
