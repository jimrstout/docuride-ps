// _shared/adapters/price-sheet.ts
//
// Rating from a provider's Published price sheet. See docs/multi-provider.md,
// sections 3 and 6.
//
// An OEM program (BRP, Kawasaki, Honda, Indian Motorcycle, Polaris ORV) has no
// API. Its rates come from a sheet staff upload, Claude reads, staff review and
// publish. Rating is then a filter: keep the sheet's rows whose eligibility the
// deal meets, and offer each as a normalized offer.
//
// Pure: the rows are read by the caller (Part 5 adds fni.price_sheet_rates), so
// a Node test can hold the eligibility rules to account.

import { makeMatches, normalizeMake, type Category } from "../providers.ts";
import type { NormalizedOffer, OfferProvider, SurchargeOption } from "../normalized-offer.ts";
import type { RateResult, RatingDeal } from "./types.ts";

/** One buyable rate on a price sheet. Mirrors a fni.price_sheet_rates row. */
export interface PriceSheetRate {
  id: string;
  product_code: string;
  product_name: string;
  /** Groups tiers that are one decision. Defaults to the product code. */
  family_code: string | null;
  plan: string | null;
  category: Category | null;

  // ── Eligibility. An empty list or a null means "any". ──────────────────
  makes: string[];
  /** Any of these appearing in the model, case-insensitively. */
  model_contains: string[];
  year_min: number | null;
  year_max: number | null;
  /** TecAssured's vehicle type codes: UTV, ATV, MCYC, PWAC, SNOW, BOAT. */
  vehicle_types: string[];
  /** "New", "Used". */
  conditions: string[];
  /** Model years old at the sale date: sale year minus model year. */
  max_age_years: number | null;
  max_odometer: number | null;
  engine_cc_min: number | null;
  engine_cc_max: number | null;
  /** Months between the in-service date and the sale date. */
  max_months_in_service: number | null;

  // ── The rate ────────────────────────────────────────────────────────────
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  dealer_cost: number;
  suggested_retail: number | null;
  options: SurchargeOption[];

  /** Set by the checks after parsing. A flagged row is never offered. */
  flagged: boolean;
}

/** The provider's Published sheet, or null when it has none. */
export interface PublishedSheet {
  id: string;
  name: string;
}

/**
 * The deal properties a sheet's rows actually test, in Verify's spelling.
 *
 * Only those: a sheet with no engine size limits does not make staff look up
 * the engine size. Make is always asked, because a Price Sheet provider is an
 * OEM program and the make is what says the deal is theirs.
 */
export function priceSheetRequiredInputs(rates: PriceSheetRate[]): string[] {
  const live = rates.filter((r) => !r.flagged);
  const need = new Set<string>(["make"]);
  for (const r of live) {
    if (r.model_contains.length > 0) need.add("model");
    if (r.year_min !== null || r.year_max !== null) need.add("year");
    if (r.vehicle_types.length > 0) need.add("vehicle_type_code");
    if (r.conditions.length > 0) need.add("new.used");
    if (r.max_age_years !== null) {
      need.add("year");
      need.add("sale.date");
    }
    if (r.max_odometer !== null) need.add("odometer");
    if (r.engine_cc_min !== null || r.engine_cc_max !== null) need.add("engine.ccs");
    if (r.max_months_in_service !== null) {
      need.add("inservice.date");
      need.add("sale.date");
    }
  }
  const order = [
    "make", "model", "year", "new.used", "vehicle_type_code", "odometer",
    "engine.ccs", "sale.date", "inservice.date",
  ];
  return order.filter((p) => need.has(p));
}

function monthsBetween(from: string, to: string): number | null {
  const a = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/**
 * Why a row does not fit the deal, in plain English, or null when it does.
 *
 * A value the deal does not carry fails a row that tests it: an offer must not
 * be shown on the strength of a field nobody filled in.
 */
export function whyNotEligible(rate: PriceSheetRate, deal: RatingDeal): string | null {
  if (rate.makes.length > 0 && !makeMatches(rate.makes, deal.make)) {
    return `It is for ${rate.makes.join(", ")}, and this is a ${deal.make ?? "vehicle with no make"}.`;
  }
  if (rate.model_contains.length > 0) {
    const model = normalizeMake(deal.model);
    if (!rate.model_contains.some((m) => normalizeMake(m) !== "" && model.includes(normalizeMake(m)))) {
      return `It is for models containing ${rate.model_contains.join(" or ")}.`;
    }
  }
  if (rate.year_min !== null && (deal.year === null || deal.year < rate.year_min)) {
    return `It is for ${rate.year_min} and newer.`;
  }
  if (rate.year_max !== null && (deal.year === null || deal.year > rate.year_max)) {
    return `It is for ${rate.year_max} and older.`;
  }
  if (rate.vehicle_types.length > 0 && !rate.vehicle_types.includes(deal.vehicle_type_code ?? "")) {
    return `It is for ${rate.vehicle_types.join(", ")}.`;
  }
  if (
    rate.conditions.length > 0 &&
    !rate.conditions.some((c) => c.toLowerCase() === (deal.condition ?? "").toLowerCase())
  ) {
    return `It is for ${rate.conditions.join(" or ")} units.`;
  }
  if (rate.max_age_years !== null) {
    const saleYear = deal.sale_date ? Number(deal.sale_date.slice(0, 4)) : null;
    if (deal.year === null || saleYear === null || saleYear - deal.year > rate.max_age_years) {
      return `It is for units up to ${rate.max_age_years} model years old.`;
    }
  }
  if (rate.max_odometer !== null && (deal.odometer === null || deal.odometer > rate.max_odometer)) {
    return `It is for units with ${rate.max_odometer.toLocaleString("en-US")} or fewer on the odometer.`;
  }
  if (rate.engine_cc_min !== null && (deal.engine_cc === null || deal.engine_cc < rate.engine_cc_min)) {
    return `It is for engines of ${rate.engine_cc_min} cc and up.`;
  }
  if (rate.engine_cc_max !== null && (deal.engine_cc === null || deal.engine_cc > rate.engine_cc_max)) {
    return `It is for engines up to ${rate.engine_cc_max} cc.`;
  }
  if (rate.max_months_in_service !== null) {
    const months =
      deal.in_service_date && deal.sale_date ? monthsBetween(deal.in_service_date, deal.sale_date) : null;
    if (months === null || months > rate.max_months_in_service) {
      return `It is for units in service ${rate.max_months_in_service} months or less.`;
    }
  }
  return null;
}

function toOffer(provider: OfferProvider, rate: PriceSheetRate): NormalizedOffer {
  return {
    provider_id: provider.id,
    provider_name: provider.name,
    product_id: null,
    product_code: rate.product_code,
    product_name: rate.product_name,
    category: rate.category,
    family_code: rate.family_code ?? rate.product_code,
    plan: rate.plan,
    term_months: rate.term_months,
    term_miles: rate.term_miles,
    deductible: rate.deductible,
    deductible_label: rate.deductible === null ? null : `$${rate.deductible} deductible`,
    disappearing_deductible: false,
    dealer_cost: rate.dealer_cost,
    provider_markup: 0,
    suggested_retail: rate.suggested_retail,
    // An OEM sheet sets no maximum the way TecAssured does. The store's pricing
    // rules decide the price.
    maximum_price: null,
    options: rate.options,
    eligibility_notes: [],
    rate_key: rate.id,
    source: {
      product: { code: rate.product_code, name: rate.product_name },
      rate: rate as unknown as Record<string, unknown>,
    },
  };
}

/** Rate a deal from a provider's Published sheet. */
export function rateFromSheet(
  provider: OfferProvider,
  sheet: PublishedSheet | null,
  rates: PriceSheetRate[],
  deal: RatingDeal
): RateResult {
  if (!sheet) {
    return { state: "Failed", reason: `No price sheet published for ${provider.name}.` };
  }
  const live = rates.filter((r) => !r.flagged);
  const fits = live.filter((r) => whyNotEligible(r, deal) === null);
  if (fits.length === 0) {
    return {
      state: "Not Offered",
      reason: `Nothing on ${provider.name}'s sheet "${sheet.name}" fits this unit.`,
    };
  }
  return {
    state: "Rated",
    offers: fits.map((r) => toOffer(provider, r)),
    request: { sheet_id: sheet.id, sheet_name: sheet.name },
    response: { rate_ids: fits.map((r) => r.id) },
  };
}
