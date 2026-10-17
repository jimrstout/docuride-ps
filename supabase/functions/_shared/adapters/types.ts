// _shared/adapters/types.ts
//
// What every provider adapter does. See docs/multi-provider.md, section 3.
//
// An adapter answers two questions for one provider and one deal: what do you
// need to know, and what do you offer. Everything it returns is a normalized
// offer or a plain-English reason; nothing above it reads a provider's own
// response.

import type { NormalizedOffer } from "../normalized-offer.ts";

/**
 * The deal, as rating sees it: the session's values with staff edits applied.
 *
 * Property names are the ones Verify already uses ("make", "new.used",
 * "engine.ccs"), so the union of every provider's required inputs feeds
 * buildVerification without a mapping table.
 */
export interface RatingDeal {
  store_id: string;
  make: string | null;
  model: string | null;
  year: number | null;
  /** "New" or "Used". */
  condition: string | null;
  vehicle_type_code: string | null;
  odometer: number | null;
  engine_cc: number | null;
  /** YYYY-MM-DD. */
  sale_date: string | null;
  in_service_date: string | null;
}

/** What one rating attempt came to. Recorded as one fni.rated_offers row. */
export type RateResult =
  | { state: "Rated"; offers: NormalizedOffer[]; request?: unknown; response?: unknown }
  | { state: "Not Offered"; reason: string; request?: unknown; response?: unknown }
  | { state: "Failed"; reason: string; request?: unknown; response?: unknown };

export interface ProviderAdapter {
  /** The property names this provider needs for this deal, in Verify's spelling. */
  requiredInputs(): Promise<string[]>;
  rate(): Promise<RateResult>;
}
