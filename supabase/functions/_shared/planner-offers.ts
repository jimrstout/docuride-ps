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
//
// ── Adapters (Part 2) ─────────────────────────────────────────────────────
// The quote is now read by _shared/adapters/tecassured-offers.ts into one
// normalized offer per rate, and _shared/normalized-offer.ts groups them. The
// types live there; they are re-exported here so callers do not change.

import {
  groupOffers,
  type NormalizedFamily,
  type NormalizedTier,
  type OfferProvider,
  type RateVariant,
} from "./normalized-offer.ts";
import { tecAssuredOffers } from "./adapters/tecassured-offers.ts";

export type {
  NormalizedFamily,
  NormalizedOffer,
  NormalizedTier,
  OfferProvider,
  RateVariant,
  SurchargeOption,
} from "./normalized-offer.ts";

/**
 * Families, each with its tiers, from a rated offer.
 *
 * Tiers are ordered cheapest first, which is how a tier list reads: Bronze,
 * Silver, Gold, Platinum. A product with no rates at all is dropped, because
 * there is nothing to sell and nothing to price.
 *
 * The TecAssured adapter reads the quote into normalized offers and
 * groupOffers folds them back into families: the same pipeline every provider
 * goes through (Part 2, docs/multi-provider.md).
 */
export function normalizeOffer(
  payload: unknown,
  provider: OfferProvider | null = null
): NormalizedFamily[] {
  return groupOffers(tecAssuredOffers(payload, provider));
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
