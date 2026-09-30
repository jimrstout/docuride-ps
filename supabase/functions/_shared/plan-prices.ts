// _shared/plan-prices.ts
//
// What each offered rate sells for, and what a saved selection costs.
//
// ── Why one module ──────────────────────────────────────────────────────
// fni-session-get prices the rated offer to show the planner, and
// fni-session-save prices the saved selections again to work out the
// additional down payment. The save must never take a price from the browser,
// and it must never price differently from the page, so both call this.
//
// A customer's price for a product is the rate's retail price (the store's
// pricing rule applied to the rate's dealer cost) plus the surcharge of every
// option that applies: each mandatory one, and each one the customer chose.
// That is the planner's surchargeCost, and it is repeated here exactly.

import type { NormalizedFamily, RateVariant } from "./planner-offers.ts";
import { priceProduct, type PricingRule } from "./planner-pricing.ts";
import {
  additionalDownPayment,
  resolvePaymentBasis,
  toCents,
  type PaymentBasis,
} from "./money.ts";

/**
 * Price every rate of every tier.
 *
 * Priced per RATE, not per product. A product's cost varies by length and
 * deductible -- USED ATV/UTV CARE runs 578 to 881 across its twelve rates --
 * so one price per product would be the wrong price for eleven of them.
 */
export function priceFamilies(
  families: NormalizedFamily[],
  rules: PricingRule[]
): NormalizedFamily[] {
  return families.map((f) => ({
    ...f,
    tiers: f.tiers.map((t) => ({
      ...t,
      rates: t.rates.map((r) => {
        const priced = priceProduct(rules, t.product_code, r.dealer_cost);
        return {
          ...r,
          retail_price: priced.unpriced_reason ? null : priced.retail_price,
          pricing_rule_id: priced.rule_id,
          unpriced_reason: priced.unpriced_reason,
        };
      }),
    })),
  }));
}

/**
 * The options that apply to a rate: every mandatory one, and each one chosen.
 * The same rule as the planner's surchargeCost.
 */
export function surchargeCost(rate: RateVariant, chosen: string[]): number {
  return rate.options
    .filter((o) => o.mandatory || chosen.includes(o.code))
    .reduce((a, o) => a + o.cost_delta, 0);
}

/**
 * What a saved selection costs the customer, from priced families.
 *
 * The rate is the saved one. With none saved, the tier's first rate, which is
 * the one the planner shows until the customer picks another. A saved rate that
 * is no longer in the offer, or a rate with no price, gives null: the caller
 * must not guess a price, and must not fall back to a browser figure.
 */
export function customerPriceFor(
  priced: NormalizedFamily[],
  productCode: string,
  rateUniqueId: string | null,
  chosenOptions: string[]
): number | null {
  for (const f of priced) {
    const tier = f.tiers.find((t) => t.product_code === productCode);
    if (!tier) continue;
    const rate = rateUniqueId
      ? tier.rates.find((r) => r.rate_unique_id === rateUniqueId)
      : tier.rates[0];
    if (!rate || rate.retail_price === null || rate.retail_price === undefined) return null;
    return rate.retail_price + surchargeCost(rate, chosenOptions);
  }
  return null;
}

// ── The session's principal, cap and additional down payment ─────────────

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * The payment basis the planner is given, from the session row.
 * fni-session-get and fni-session-save both call this, so the principal the
 * customer is shown is the principal the save measures against.
 */
export function sessionPaymentBasis(s: Record<string, unknown>): PaymentBasis {
  return resolvePaymentBasis({
    tilaAmountFinanced: num(s.tila_amount_financed),
    amountFinanced: num(s.amount_financed),
    apr: num(s.apr),
    interestRate: num(s.interest_rate),
    termMonths: num(s.finance_term_total),
    lienholderName: (s.lienholder_name as string | null) ?? null,
  });
}

/**
 * The finance company's maximum amount financed, or null. Always null on a
 * cash deal: there is no finance company, so there is no maximum.
 */
export function sessionCap(s: Record<string, unknown>, basis: PaymentBasis): number | null {
  if (basis.kind === "cash") return null;
  return num(s.max_amount_financed);
}

/** One saved Included selection, as selected_products holds it. */
export interface SavedSelection {
  provider_product_id: string;
  rate_unique_id: string | null;
  selected_options: unknown;
}

/**
 * The additional down payment for a set of saved selections, priced on the
 * server. Null, with a reason, when it cannot be worked out honestly: a cash
 * deal, no known principal, or a selection that has no current price.
 */
export function additionalDownForSelections(
  s: Record<string, unknown>,
  priced: NormalizedFamily[],
  selections: SavedSelection[]
): { value: number | null; reason: string | null } {
  const basis = sessionPaymentBasis(s);
  if (basis.kind === "cash") return { value: null, reason: "cash deal" };
  if (basis.principal === null) return { value: null, reason: "no principal known" };

  const prices: number[] = [];
  for (const sel of selections) {
    const chosen = Array.isArray(sel.selected_options)
      ? (sel.selected_options as unknown[]).map(String)
      : [];
    const price = customerPriceFor(priced, sel.provider_product_id, sel.rate_unique_id, chosen);
    if (price === null) {
      return {
        value: null,
        reason: `no current price for ${sel.provider_product_id} rate ${sel.rate_unique_id ?? "(default)"}`,
      };
    }
    prices.push(price);
  }

  // The same arithmetic planTotals uses: prices summed and rounded, then the
  // amount past the maximum.
  const productTotal = toCents(prices.reduce((a, p) => a + p, 0));
  return {
    value: additionalDownPayment(basis.principal, productTotal, sessionCap(s, basis)),
    reason: null,
  };
}
