// _shared/price-cap.ts
//
// What a contract is submitted at, and whose rule on the maximum applies.
//
// fni-contract-submit treated dealer cost + provider markup + options as the
// most a product may be sold for, and refused before sending anything priced
// above it. That is only true on the QA dealer 3-306, where TecAssured enforces
// exactly that cap ("contract purchase price of $1,450.00 cannot be greater
// than the maximum selling price of $1,094.00", 2026-09-25). A production
// dealer's cap is the dealer's own arrangement with TecAssured, and we cannot
// see it. So:
//
//   Test at maximum    a test session on the QA server. Every product is
//                      submitted at that maximum, automatically, and the cap
//                      check stays as a guard.
//   Provider decides   everything else. No cap is assumed: the customer's
//                      price is sent, and TecAssured's answer stands, its
//                      refusal shown in plain English.
//
// Before go-live, confirm with TecAssured how each production dealer's cap
// works (docs/multi-provider.md, section 11, Go-live items).
//
// Pure, so a Node test holds the rules.

import type { ProductSelection, ResolvedSelection } from "./offer-selections.ts";
import { QA_HOST, hostOf } from "./contract-guard.ts";

export type PricePolicy = "Test at maximum" | "Provider decides";

export function pricePolicy(
  session: { is_test: boolean | null | undefined },
  apiBaseUrl: string | null | undefined
): PricePolicy {
  return session.is_test === true && hostOf(apiBaseUrl) === QA_HOST ? "Test at maximum" : "Provider decides";
}

/** Dollars to the cent, from a sum of dollar amounts. */
function toCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Each selection priced at the maximum its rate allows. A rate whose maximum
 * cannot be worked out (no dealer cost) keeps the price it had; the submit
 * refuses it before anything is sent, for its missing dealer cost.
 */
export function atMaximum(
  selections: ProductSelection[],
  resolved: ResolvedSelection[]
): ProductSelection[] {
  const max = new Map(resolved.map((r) => [r.rateUniqueId, r.offeredPrice]));
  return selections.map((s) => {
    const m = max.get(s.rate_unique);
    return m === null || m === undefined ? s : { ...s, retail_price: toCents(m) };
  });
}

/** TecAssured's refusal of a contract, in words staff can act on. */
export function refusalInPlainEnglish(error: unknown, productName?: string | null): string {
  const raw = String(error ?? "").trim().replace(/[.\s]+$/, "");
  const what = productName ? `${productName}` : "the contract";
  const cap = raw.match(/purchase price of \$?([\d,]+(?:\.\d+)?) cannot be greater than the maximum selling price of \$?([\d,]+(?:\.\d+)?)/i);
  if (cap) {
    return (
      `TecAssured would not accept ${what}: its price, $${cap[1]}, is above the most ` +
      `TecAssured allows this dealer to sell it for, $${cap[2]}. Lower the price to ` +
      `$${cap[2]} or less and submit again.`
    );
  }
  if (/no rate found matching criteria/i.test(raw)) {
    return (
      `TecAssured would not accept ${what}: it has no rate for this product that ` +
      `matches the vehicle. Check the vehicle type on Verify; an On-Road product ` +
      `cannot go on an off-road vehicle, or the reverse.`
    );
  }
  if (/duplicate/i.test(raw)) {
    return (
      `TecAssured would not accept ${what}: it already has this contract for this ` +
      `deal. Check TecAssured before submitting again.`
    );
  }
  return raw === ""
    ? `TecAssured would not accept ${what}, and did not say why.`
    : `TecAssured would not accept ${what}: ${raw}.`;
}
