// _shared/planner-pricing.ts
//
// Cost-banded markup resolution for the Ownership Planner.
//
// New file rather than an edit to an existing _shared module: nothing else
// imports this, so rr-report and zoho-sync are untouched.
//
// A flat percentage does not work. 250% on a $199 contract is defensible --
// a predictable share of store profit gets spent on customer-satisfaction
// issues that fall outside strict plan coverage. The same 250% on a $1,349
// vehicle service contract produces an unsellable number. markup_max_dollars
// is what stops it.

export interface PricingRule {
  id: string;
  tenant_id: string;
  store_id: string | null;
  product_code: string | null;
  cost_floor: number;
  cost_ceiling: number;
  markup_percent: number;
  markup_max_dollars: number | null;
  markup_min_dollars: number;
  round_to: number;
  active: boolean;
}

export interface PricedResult {
  /** Price to show the customer. */
  retail_price: number;
  /** The rule that produced it, so pricing is explainable after the fact. */
  rule_id: string | null;
  /** Why there is no price, when there is no price. */
  unpriced_reason: string | null;
}

/**
 * Round to the nearest multiple of `step`, half-up.
 * step of 5 gives prices ending in 0 or 5. step <= 0 disables rounding.
 */
export function roundTo(value: number, step: number): number {
  if (!(step > 0)) return Math.round((value + Number.EPSILON) * 100) / 100;
  return Math.round((value / step) + Number.EPSILON) * step;
}

/**
 * Resolution order, most specific first:
 *   1. exact product_code for the store
 *   2. catch-all band for the store (product_code null)
 *   3. tenant default (store_id null), exact code then catch-all
 *
 * Within each tier the band must contain the cost. Bands are treated as
 * [floor, ceiling) so adjacent bands do not both match at the boundary.
 */
export function resolveRule(
  rules: PricingRule[],
  productCode: string,
  dealerCost: number
): PricingRule | null {
  const inBand = (r: PricingRule) =>
    r.active && dealerCost >= r.cost_floor && dealerCost < r.cost_ceiling;

  const tiers: ((r: PricingRule) => boolean)[] = [
    (r) => r.store_id !== null && r.product_code === productCode,
    (r) => r.store_id !== null && r.product_code === null,
    (r) => r.store_id === null && r.product_code === productCode,
    (r) => r.store_id === null && r.product_code === null,
  ];

  for (const tier of tiers) {
    const match = rules.filter((r) => inBand(r) && tier(r));
    if (match.length > 0) {
      // Narrowest band wins when bands overlap, so a specific band beats a
      // wide catch-all defined at the same tier.
      match.sort(
        (a, b) =>
          (a.cost_ceiling - a.cost_floor) - (b.cost_ceiling - b.cost_floor)
      );
      return match[0];
    }
  }
  return null;
}

/**
 * Price a product from its dealer cost.
 *
 * price = cost + least(cost * markup_percent, markup_max_dollars)
 *         floored at markup_min_dollars, then rounded.
 *
 * Returns no price rather than a guessed one when no band covers the cost.
 * A self-guided session showing an invented price is the failure mode this
 * whole table exists to prevent, so the caller must treat an unpriced product
 * as not presentable.
 */
export function priceProduct(
  rules: PricingRule[],
  productCode: string,
  dealerCost: number | null | undefined
): PricedResult {
  if (
    dealerCost === null ||
    dealerCost === undefined ||
    !Number.isFinite(dealerCost) ||
    dealerCost < 0
  ) {
    return {
      retail_price: 0,
      rule_id: null,
      unpriced_reason: "No dealer cost on the rated offer",
    };
  }

  const rule = resolveRule(rules, productCode, dealerCost);
  if (!rule) {
    return {
      retail_price: 0,
      rule_id: null,
      unpriced_reason: `No pricing band covers a cost of ${dealerCost} for ${productCode}`,
    };
  }

  const pctMarkup = dealerCost * (rule.markup_percent / 100);
  const capped =
    rule.markup_max_dollars !== null && rule.markup_max_dollars !== undefined
      ? Math.min(pctMarkup, rule.markup_max_dollars)
      : pctMarkup;
  const floored = Math.max(capped, rule.markup_min_dollars);

  return {
    retail_price: roundTo(dealerCost + floored, rule.round_to),
    rule_id: rule.id,
    unpriced_reason: null,
  };
}
