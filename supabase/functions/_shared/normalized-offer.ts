// _shared/normalized-offer.ts
//
// One shape for every provider's offers. See docs/multi-provider.md, section 2.
//
// An adapter turns whatever its provider sends (a TecAssured quote, the rows of
// a published price sheet) into NormalizedOffers: one per buyable rate. Nothing
// above the adapters reads a provider's response; pricing reads dealer_cost and
// the provider, and the planner reads families.
//
// groupOffers folds offers back into the families, tiers and rates the planner
// has always rendered, so the screens do not change shape. For a TecAssured
// quote the result is identical, field for field, to what normalizeOffer
// returned before adapters existed; test/multi-provider-adapters.test.mjs holds
// it to that against a real quote.

import type { Category } from "./providers.ts";

// ── The planner's shapes ─────────────────────────────────────────────────

export interface SurchargeOption {
  code: string;
  label: string;
  /** Added to dealer cost when it applies. Can be negative: GPS EQUIPPED is -50. */
  cost_delta: number;
  /** Not a choice. Rides along whether or not the customer ticks it. */
  mandatory: boolean;
  /** True when the rated offer already applied it. */
  applied: boolean;
}

/** One buyable combination of length, deductible and price. */
export interface RateVariant {
  rate_unique_id: string;
  term_months: number | null;
  /** 0 on every powersports rate seen. Omit from the interface when falsy. */
  term_miles: number | null;
  deductible: number | null;
  /** The provider's own words: "0 Ded", "50 Ded", "100 Dis Ded". */
  deductible_code: string | null;
  /** The deductible falls away under the provider's terms. */
  disappearing_deductible: boolean;
  dealer_cost: number | null;
  /** The provider's markup, already inside its maximum selling price. */
  provider_markup: number;
  /**
   * The most this rate may be sold for, before options. The provider rejects a
   * submit above it, so the planner prices inside it.
   */
  offered_price: number | null;
  options: SurchargeOption[];
  /** The provider's object, verbatim. Recorded as the selection's rate snapshot. */
  raw: Record<string, unknown>;

  // Filled by the pricing layer, per rate, because cost varies per rate.
  retail_price?: number | null;
  pricing_rule_id?: string | null;
  unpriced_reason?: string | null;
}

/** One product: a tier within its family. */
export interface NormalizedTier {
  /** What selected_products.provider_product_id holds. */
  product_code: string;
  product_name: string;
  /** Also the family code. */
  product_type: string;
  rates: RateVariant[];
  raw: Record<string, unknown>;
  /**
   * Who offered this tier, when it differs from its family's: a Side by Side
   * menu slot can put two providers' products in one decision. Absent
   * otherwise, so a family read from one quote is exactly what it always was.
   */
  provider_id?: string | null;
  provider_name?: string | null;
}

/** One decision for the customer: which tier of this family, or none. */
export interface NormalizedFamily {
  family_code: string;
  /** Who offered it. Null only on a family built before providers existed. */
  provider_id: string | null;
  provider_name: string | null;
  tiers: NormalizedTier[];
}

/** The provider an offer came from. */
export interface OfferProvider {
  id: string;
  name: string;
}

// ── The normalized offer ─────────────────────────────────────────────────

/** One buyable rate, from any provider. */
export interface NormalizedOffer {
  provider_id: string | null;
  provider_name: string | null;
  /** The catalog row, when the caller has matched one. */
  product_id: string | null;
  /** The provider's own product code. */
  product_code: string;
  product_name: string;
  category: Category | null;
  /** Groups the tiers that are one decision. */
  family_code: string;
  /** Plan or coverage level: "Gold", "Plan A". */
  plan: string | null;
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  deductible_label: string | null;
  disappearing_deductible: boolean;
  dealer_cost: number | null;
  /** The provider's markup inside its maximum price. 0 when it has none. */
  provider_markup: number;
  suggested_retail: number | null;
  /** A cap the provider enforces at submit. */
  maximum_price: number | null;
  options: SurchargeOption[];
  eligibility_notes: string[];
  /** What contracts this exact offer: TecAssured's rateUnique, a sheet row id. */
  rate_key: string;
  /** The provider's own objects, kept only to record what was offered. */
  source: { product: Record<string, unknown>; rate: Record<string, unknown> };
}

// ── Folding offers back into families ────────────────────────────────────

function toRate(o: NormalizedOffer): RateVariant {
  return {
    rate_unique_id: o.rate_key,
    term_months: o.term_months,
    term_miles: o.term_miles,
    deductible: o.deductible,
    deductible_code: o.deductible_label,
    disappearing_deductible: o.disappearing_deductible,
    dealer_cost: o.dealer_cost,
    provider_markup: o.provider_markup,
    offered_price: o.maximum_price,
    options: o.options,
    raw: o.source.rate,
  };
}

/**
 * Rates in the order a customer should read them: shortest first, and within a
 * length, the smallest deductible first. Not by price: price is the consequence
 * of the choice, not the axis of it.
 */
function sortRates(rates: RateVariant[]): RateVariant[] {
  return [...rates].sort((a, b) => {
    const months = (a.term_months ?? 0) - (b.term_months ?? 0);
    if (months !== 0) return months;
    return (a.deductible ?? 0) - (b.deductible ?? 0);
  });
}

/** The cheapest thing this tier can be sold for, for ordering tiers. */
function tierFloor(tier: NormalizedTier): number {
  const prices = tier.rates
    .map((r) => r.offered_price)
    .filter((p): p is number => p !== null);
  return prices.length > 0 ? Math.min(...prices) : Number.POSITIVE_INFINITY;
}

/**
 * Families, each with its tiers, each tier with its rates.
 *
 * Grouped by provider and family, so two providers' "Theft" are two decisions.
 * Tiers are ordered cheapest first (Bronze, Silver, Gold, Platinum), rates
 * shortest first, families by family code and then provider. An offer with no
 * product code is dropped: there is nothing to record it against.
 */
export function groupOffers(offers: NormalizedOffer[]): NormalizedFamily[] {
  const families = new Map<string, NormalizedFamily>();
  const tiers = new Map<string, NormalizedTier>();

  for (const o of offers) {
    if (o.product_code === "") continue;
    const familyKey = `${o.provider_id ?? ""}\u0000${o.family_code}`;
    let family = families.get(familyKey);
    if (!family) {
      family = {
        family_code: o.family_code,
        provider_id: o.provider_id,
        provider_name: o.provider_name,
        tiers: [],
      };
      families.set(familyKey, family);
    }

    const tierKey = `${familyKey}\u0000${o.product_code}`;
    let tier = tiers.get(tierKey);
    if (!tier) {
      tier = {
        product_code: o.product_code,
        product_name: o.product_name,
        product_type: o.family_code,
        rates: [],
        raw: o.source.product,
      };
      tiers.set(tierKey, tier);
      family.tiers.push(tier);
    }
    tier.rates.push(toRate(o));
  }

  for (const tier of tiers.values()) tier.rates = sortRates(tier.rates);

  return [...families.values()]
    .map((f) => ({ ...f, tiers: f.tiers.sort((a, b) => tierFloor(a) - tierFloor(b)) }))
    .sort(
      (a, b) =>
        a.family_code.localeCompare(b.family_code) ||
        (a.provider_name ?? "").localeCompare(b.provider_name ?? "")
    );
}
