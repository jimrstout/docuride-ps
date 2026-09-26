// _shared/planner-offers.ts
//
// Turning a TecAssured quote into the shape the planner renders.
//
// ── Rewritten against a real quote (2026-09-26) ──────────────────────────
// The previous version was written before credentials existed and said so. It
// guessed, and it guessed wrong in two ways that mattered:
//
//   It looked for products under a top-level `products` key. A real quote nests
//   them at quote.vehicles[].products[], so normalizeOffer returned an empty
//   array for every live response.
//
//   It modelled one price per product. A real product carries a list of RATES,
//   and the choice between them is the customer's: USED ATV/UTV CARE comes back
//   with twelve, being four lengths times three deductibles.
//
// ── Eleven products is really five decisions ─────────────────────────────
// The quote for dealer 3-306 offers eleven products, and four of them are
// Platinum, Gold, Silver and Bronze: tiers of one thing, not four independent
// yes/no questions. Walking a customer through eleven screens would invite them
// to buy Platinum and Gold and Silver together, which is nonsense.
//
// `ptype` groups them, and the provider's own `rateClass` agrees with it on
// every product in the live data, so the grouping is theirs and not ours:
//
//   PPM  Platinum / Gold / Silver / Bronze     mechanical protection
//   VSA  Care / Care with Service Drive        service contract
//   THP  Theft Plan A / Plan B                theft
//   BAT  Battery Plus / Battery Standard      battery
//   TAW  Tire & Wheel                         one tier, so no tier choice
//
// So this returns families, each with tiers, each tier with its rates. One
// decision per family.
//
// ── What the mileage dimension turned out to be ──────────────────────────
// Nothing. termMiles is 0 on every rate of every product in the powersports
// data, because mileage limits are a car idea. It is carried through so an AUTO
// quote can use it, and the UI is expected to omit it when it is 0: a line
// reading "0 miles" is worse than no line.

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
  /** deduct.type DIS. The deductible falls away under the group's terms. */
  disappearing_deductible: boolean;
  dealer_cost: number | null;
  /** The provider's markup, already inside its maximum selling price. */
  provider_markup: number;
  /**
   * The most this rate may be sold for, before options.
   *
   * dealer_cost + provider_markup. The provider rejects a submit above it:
   * "contract purchase price of $1,450.00 cannot be greater than the maximum
   * selling price of $1,094.00". Carried here so the planner can price inside
   * the cap rather than finding out at submit.
   */
  offered_price: number | null;
  options: SurchargeOption[];
  /** The provider's object, verbatim. */
  raw: Record<string, unknown>;

  // Filled by the pricing layer, per rate, because cost varies per rate.
  retail_price?: number | null;
  pricing_rule_id?: string | null;
  unpriced_reason?: string | null;
}

/** One product: a tier within its family. */
export interface NormalizedTier {
  /** The product's `unique`. What selected_products.provider_product_id holds. */
  product_code: string;
  /** `label`, the provider's display name. */
  product_name: string;
  /** `ptype`. Also the family code. */
  product_type: string;
  rates: RateVariant[];
  raw: Record<string, unknown>;
}

/** One decision for the customer: which tier of this family, or none. */
export interface NormalizedFamily {
  family_code: string;
  tiers: NormalizedTier[];
}

// ── Reading the provider's values ────────────────────────────────────────

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** TecAssured money is { amount, currency }. Confirmed against a real quote. */
function amountOf(money: unknown): number | null {
  if (!money || typeof money !== "object") return null;
  return asNumber((money as Record<string, unknown>).amount);
}

function arrayAt(o: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(o[key]) ? (o[key] as unknown[]) : [];
}

function attributes(o: Record<string, unknown>): Record<string, unknown> {
  const a = o.attributes;
  return a && typeof a === "object" && !Array.isArray(a)
    ? (a as Record<string, unknown>)
    : {};
}

/** Products live at quote.vehicles[].products[]. A bare vehicles[] is accepted
 *  too, because rated_offers.response_payload may hold either. */
function productsIn(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;
  const root = (o.quote && typeof o.quote === "object" ? o.quote : o) as Record<string, unknown>;

  const out: Record<string, unknown>[] = [];
  for (const vehicle of arrayAt(root, "vehicles")) {
    if (!vehicle || typeof vehicle !== "object") continue;
    for (const p of arrayAt(vehicle as Record<string, unknown>, "products")) {
      if (p && typeof p === "object") out.push(p as Record<string, unknown>);
    }
  }
  return out;
}

function normalizeOptions(raw: unknown[]): SurchargeOption[] {
  return raw
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => ({
      code: asString(o.unique ?? o.code) ?? "",
      label: asString(o.label ?? o.desc) ?? "",
      cost_delta: amountOf(o.dealerCost) ?? 0,
      mandatory: o.mandatory === true,
      applied: o.selected === true,
    }))
    .filter((o) => o.code !== "" || o.label !== "");
}

function normalizeRate(raw: Record<string, unknown>): RateVariant {
  const attrs = attributes(raw);
  const dealerCost = amountOf(raw.dealerCost);
  const providerMarkup =
    amountOf((raw.providerMarkup as Record<string, unknown> | undefined)?.adjustment) ?? 0;

  return {
    rate_unique_id: asString(raw.unique) ?? "",
    term_months: asNumber(raw.termMonths),
    term_miles: asNumber(raw.termMiles),
    deductible: amountOf(raw.dealerDeduct),
    deductible_code: asString(attrs["deduct.code"]),
    disappearing_deductible: asString(attrs["deduct.type"]) === "DIS",
    dealer_cost: dealerCost,
    provider_markup: providerMarkup,
    offered_price: dealerCost === null ? null : dealerCost + providerMarkup,
    options: normalizeOptions(arrayAt(raw, "options")),
    raw,
  };
}

/**
 * Rates in the order a customer should read them: shortest first, and within a
 * length, the smallest deductible first.
 *
 * Not by price. Price is the consequence of the choice, not the axis of it, and
 * sorting by price would shuffle the lengths around.
 */
function sortRates(rates: RateVariant[]): RateVariant[] {
  return [...rates].sort((a, b) => {
    const months = (a.term_months ?? 0) - (b.term_months ?? 0);
    if (months !== 0) return months;
    return (a.deductible ?? 0) - (b.deductible ?? 0);
  });
}

function normalizeTier(raw: Record<string, unknown>): NormalizedTier {
  // label, ptype and unique: read off a real quote. `ident` is "0" on every
  // product, so it is not an identifier despite the name. See
  // _shared/offer-selections.ts, which learned the same lesson.
  const code = asString(raw.unique) ?? "";
  return {
    product_code: code,
    product_name: asString(raw.label ?? raw.desc) ?? code,
    product_type: asString(raw.ptype) ?? "Unknown",
    rates: sortRates(arrayAt(raw, "rates")
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map(normalizeRate)),
    raw,
  };
}

/** The cheapest thing this tier can be sold for, for ordering tiers. */
function tierFloor(tier: NormalizedTier): number {
  const prices = tier.rates
    .map((r) => r.offered_price)
    .filter((p): p is number => p !== null);
  return prices.length > 0 ? Math.min(...prices) : Number.POSITIVE_INFINITY;
}

/**
 * Families, each with its tiers, from a rated offer.
 *
 * Tiers are ordered cheapest first, which is how a tier list reads: Bronze,
 * Silver, Gold, Platinum. A product with no rates at all is dropped, because
 * there is nothing to sell and nothing to price.
 */
export function normalizeOffer(payload: unknown): NormalizedFamily[] {
  const byFamily = new Map<string, NormalizedTier[]>();

  for (const raw of productsIn(payload)) {
    const tier = normalizeTier(raw);
    if (tier.product_code === "" || tier.rates.length === 0) continue;
    const list = byFamily.get(tier.product_type) ?? [];
    list.push(tier);
    byFamily.set(tier.product_type, list);
  }

  return [...byFamily.entries()]
    .map(([family_code, tiers]) => ({
      family_code,
      tiers: tiers.sort((a, b) => tierFloor(a) - tierFloor(b)),
    }))
    .sort((a, b) => a.family_code.localeCompare(b.family_code));
}

/** Every tier across every family, for callers that need a flat list. */
export function allTiers(families: NormalizedFamily[]): NormalizedTier[] {
  return families.flatMap((f) => f.tiers);
}

/** A rate by its id, wherever it sits. */
export function findRate(
  families: NormalizedFamily[],
  rateUniqueId: string
): { family: NormalizedFamily; tier: NormalizedTier; rate: RateVariant } | null {
  for (const family of families) {
    for (const tier of family.tiers) {
      const rate = tier.rates.find((r) => r.rate_unique_id === rateUniqueId);
      if (rate) return { family, tier, rate };
    }
  }
  return null;
}
