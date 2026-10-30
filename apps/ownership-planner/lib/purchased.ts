// lib/purchased.ts: products already purchased on this deal.
//
// A product under a Live or Submit Status Unknown contract is purchased
// (supabase/functions/_shared/purchased.ts). On the Ownership Planner and the
// conventional menu it shows as purchased, included, at the price it was
// sold for, and nothing about it can be changed. Everything not yet
// submitted stays selectable. fni-session-save refuses to rewrite a purchased
// product's row whatever a browser sends, so this is what the screen shows,
// not what keeps it safe.
//
// No imports, so a Node test can load it.

export interface PurchasedRef {
  provider_id: string | null;
  provider_product_id: string;
}

export const PURCHASED_LABEL = "Purchased";
export const PURCHASED_NOTE = "This is already on your contract, so it can't be changed here.";

export function purchasedKey(providerId: string | null | undefined, productCode: string): string {
  return `${providerId ?? ""}:${productCode}`;
}

export function purchasedSet(refs: PurchasedRef[] | null | undefined): Set<string> {
  return new Set((refs ?? []).map((r) => purchasedKey(r.provider_id, r.provider_product_id)));
}

/**
 * The purchased tier of a family, or null. A family is one decision, so a
 * family with a purchased tier is locked to it.
 */
export function purchasedTierOf<T extends { tier: { product_code: string; provider_id?: string | null } }>(
  family: { provider_id: string | null; tiers: T[] },
  purchased: Set<string>
): T | null {
  return (
    family.tiers.find((t) => purchased.has(purchasedKey(t.tier.provider_id ?? family.provider_id, t.tier.product_code))) ??
    null
  );
}

/** What a purchased product was sold for, from its saved row. */
export function savedPrice(row: { customer_price?: string | number | null; retail_price?: string | number | null } | undefined): number | null {
  const v = row?.customer_price ?? row?.retail_price ?? null;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
