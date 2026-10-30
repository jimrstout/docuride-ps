// _shared/purchased.ts
//
// Products already purchased on a deal, and adding more after a contract.
//
// Adding products after a contract is submitted is the accepted model
// (2026-10-30). So a session with a live contract still takes the customer's
// choices, from the Ownership Planner and the conventional menu alike:
//
//   purchased   a product under a Live or Submit Status Unknown contract. It
//               shows as purchased and cannot be unchecked or changed. Its
//               saved row is never rewritten, whatever a browser sends.
//   the rest    stays selectable, and a new product included is submitted as
//               usual: Submit sends only products with no live contract.
//
// A session the documents finished (Finalized) still saves while it has a live
// contract. When a finished save includes a product with no contract yet, the
// session goes back to Products Selected, so Submit takes it, the way a void
// that leaves no live contract reopens it (_shared/session-reopen.ts). A
// voided contract no longer holds its product: that product is selectable
// again.
//
// Pure, so a Node test can hold it.

/** The contract states that hold a product as purchased. */
export const PURCHASED_STATES = ["Live", "Submit Status Unknown"] as const;

export const FINALIZED = "Finalized";
export const PRODUCTS_SELECTED = "Products Selected";

/** A contract on the deal, as fni.agreement_products holds it. */
export interface DealContract {
  provider_id: string | null;
  provider_product_id: string | null;
  status: string;
}

const key = (provider: string | null | undefined, product: string | null | undefined) =>
  `${provider ?? ""}:${product ?? ""}`;

/** "provider:product" for every product a live contract holds. */
export function purchasedKeys(contracts: DealContract[]): Set<string> {
  return new Set(
    contracts
      .filter((c) => (PURCHASED_STATES as readonly string[]).includes(c.status) && c.provider_product_id)
      .map((c) => key(c.provider_id, c.provider_product_id))
  );
}

export function isPurchased(purchased: Set<string>, providerId: string | null, productCode: string): boolean {
  return purchased.has(key(providerId, productCode));
}

/**
 * The decisions a save may write, and the ones it leaves as they are because
 * the product is purchased.
 */
export function splitLocked<T extends { product_code?: string }>(
  decisions: T[],
  purchased: Set<string>,
  providerOf: (d: T) => string | null
): { writable: T[]; locked: T[] } {
  const writable: T[] = [];
  const locked: T[] = [];
  for (const d of decisions) {
    (isPurchased(purchased, providerOf(d), String(d.product_code ?? "")) ? locked : writable).push(d);
  }
  return { writable, locked };
}

/**
 * Whether a save may change this session at all. A Finalized session saves
 * only while it has a live contract: one with none left reopens on its own.
 */
export function finalizedMaySave(status: string, purchased: Set<string>): boolean {
  return status !== FINALIZED || purchased.size > 0;
}

/**
 * The status after a finished save on a session that already has contracts:
 * back to Products Selected when the plan now includes a product with no
 * contract, so Submit takes it. Null leaves the status to the usual rules.
 */
export function statusAfterAdding(
  status: string,
  complete: boolean,
  newlyIncluded: number
): string | null {
  return complete && status === FINALIZED && newlyIncluded > 0 ? PRODUCTS_SELECTED : null;
}

// ── Rating while a contract is live (2026-10-30) ──────────────────────────
//
// Products can be added after a contract, so rating, Rate again and Confirm
// and Continue work while contracts are live. A rating only ever affects the
// products not yet submitted: a purchased product stays exactly as it is, its
// selection never moved onto a new rate or marked, and the session keeps its
// status, so the contracts panel and Submit stay where they are.

/** The status after a rating: kept while any contract is live, else the usual rule's. */
export function statusAfterRatingWithContracts(current: string, usual: string, purchased: Set<string>): string {
  return purchased.size > 0 ? current : usual;
}

/** The selections a rating may move or mark: none under a live contract. */
export function notPurchased<T extends { provider_id: string | null; provider_product_id: string | null }>(
  selections: T[],
  purchased: Set<string>
): T[] {
  return selections.filter((s) => !isPurchased(purchased, s.provider_id, String(s.provider_product_id ?? "")));
}

/** Rating is refused on these statuses; Finalized only when no contract is live. */
export function ratingRefused(status: string, purchased: Set<string>): boolean {
  if (status === "Written Back" || status === "Cancelled") return true;
  return status === FINALIZED && purchased.size === 0;
}
