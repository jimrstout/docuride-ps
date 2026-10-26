// _shared/rerate.ts
//
// What a re-rate that fails does to the offers already held.
//
// A session's rated offers are one row per provider, and a rating attempt
// used to overwrite that row whatever came back. So a timeout on a re-rate
// (Confirm and Continue, the console's Rate again) threw away a good quote the
// customer may already have chosen from, and the deal could no longer be
// submitted. Now a failure keeps the last good offers and is recorded beside
// them as a warning. Only an answer from the provider (Rated or Not Offered)
// replaces them.
//
// Pure, so a Node test holds the rules.

/** The prior row, as much of it as the rule reads. */
export interface PriorOffer {
  state: string;
  out_of_date: boolean;
  request_payload: unknown;
  product_count: number;
  rated_at: string | null;
}

/** JSON with its keys sorted, so a jsonb round trip compares equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Do two rate requests ask about the same deal? rateDate is left out: it is
 * the day the request is made, not something about the deal.
 */
export function sameRatingRequest(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const { rateDate: _a, ...restA } = a as Record<string, unknown>;
  const { rateDate: _b, ...restB } = b as Record<string, unknown>;
  return canonical(restA) === canonical(restB);
}

/** Does a failed attempt keep the prior row? Only a Rated one. */
export function keepsPrior(prior: PriorOffer | null): prior is PriorOffer {
  return prior !== null && prior.state === "Rated";
}

/**
 * Are the kept offers still the answer for this deal?
 *
 * When the failed attempt got as far as building its request, the request
 * decides: the offers are current only if it asked about exactly the same
 * deal. Confirm and Continue marks every row out of date and then re-rates,
 * so this is what lets a timeout there leave the deal submittable. A failure
 * before any request was built proves nothing, so the row keeps the out of
 * date mark it had.
 */
export function keptStillCurrent(prior: PriorOffer, failedRequest: unknown): boolean {
  if (failedRequest && typeof failedRequest === "object") {
    return sameRatingRequest(prior.request_payload, failedRequest);
  }
  return !prior.out_of_date;
}

/** The warning staff see, in plain English. */
export function keptWarning(providerName: string, reason: string, current: boolean): string {
  const why = reason.replace(/[.\s]+$/, "");
  return current
    ? `${providerName} could not rate again (${why}). The last good offers are kept, so the deal can still go ahead on them.`
    : `${providerName} could not rate again (${why}). The last good offers are kept but are out of date, so rate again before submitting.`;
}
