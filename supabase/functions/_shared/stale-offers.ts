// _shared/stale-offers.ts: what a new rating no longer offers, said plainly.
//
// Rating again can take products, terms and prices away. Nothing from an
// earlier rating may linger:
//
//   prepared cells  a column's choice whose option the current rating does not
//                   offer comes off the menu and out of every column total,
//                   with one notice per product naming the columns it left:
//                   "GAP is no longer offered for this deal after rating
//                   again, so it was removed from Platinum, Gold and Silver."
//   deal prices     a price staff set that no longer fits the current rating
//                   (below its dealer cost, or outside the staff range with no
//                   manager's approval) is not applied; the current rating's
//                   price is used, and the notice says so
//   selections      already held: one not matching the fresh rating to the
//                   cent stays out of date and Submit refuses it
//                   (_shared/spent-rates.ts, _shared/price-guard.ts)
//
// And what the provider said about a product it did not rate ("No rates
// available") is shown on Details, naming the product.
//
// Pure, so a Node test can hold it.

import { checkPrice, termLabel, type Band } from "./menu-presets.ts";

/** "A", "A and B", "A, B and C". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** An option key's parts (_shared/menu-presets.ts optionKey). */
export function parseOptionKey(key: string): { provider_id: string; product_code: string; term_months: number } | null {
  const parts = key.split("|");
  if (parts.length < 6) return null;
  return { provider_id: parts[0], product_code: parts[1], term_months: Number(parts[2]) || 0 };
}

/** A column's prepared choice the current rating no longer offers. */
export interface StaleCell {
  /** The column's name: "Platinum". */
  column: string;
  category: string;
  key: string;
}

/**
 * One notice per product taken off the menu. The product is named from the
 * catalog; when the product is still offered but not that option, the term
 * is named too ("Mechanical Protection, 4 years").
 */
export function removedNotices(
  stale: StaleCell[],
  nameFor: (providerId: string, productCode: string) => string | null,
  stillOffered: (providerId: string, productCode: string) => boolean,
): string[] {
  const byName = new Map<string, string[]>();
  for (const c of stale) {
    const k = parseOptionKey(c.key);
    const base = (k && nameFor(k.provider_id, k.product_code)) ?? c.category;
    const name = k && stillOffered(k.provider_id, k.product_code) ? `${base}, ${termLabel(k.term_months)}` : base;
    const cols = byName.get(name) ?? [];
    if (!cols.includes(c.column)) cols.push(c.column);
    byName.set(name, cols);
  }
  return [...byName.entries()].map(
    ([name, cols]) => `${name} is no longer offered for this deal after rating again, so it was removed from ${joinList(cols)}.`
  );
}

/** A deal price, as fni.session_menu_prices holds it. */
export interface StoredPrice {
  retail_price: number;
  approved_by: string | null;
}

/**
 * Does a price staff set still fit the current rating? Never below its dealer
 * cost; outside the staff range only with a manager's approval.
 */
export function dealPriceFits(deal: StoredPrice, dealerCost: number, band: Band): boolean {
  const c = checkPrice(Math.round(Number(deal.retail_price) * 100), dealerCost, band);
  if (!c.ok) return false;
  if ((c.above_band || c.below_band) && !deal.approved_by) return false;
  return true;
}

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The notice for a price that was not applied. */
export function priceNotAppliedNotice(name: string, setCents: number, ratingCents: number | null): string {
  return (
    `${name}: the price of ${money(setCents)} was set on an earlier rating and does not fit this one, so it is not applied.` +
    (ratingCents === null ? "" : ` The rating's price of ${money(ratingCents)} is used.`)
  );
}

const MESSAGE_KEYS = ["message", "messages", "error", "errors", "warning", "warnings", "reason", "note", "notes"];

function texts(v: unknown): string[] {
  if (typeof v === "string") return v.trim() === "" ? [] : [v.trim()];
  if (Array.isArray(v)) return v.flatMap(texts);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return texts(o.message ?? o.text ?? o.description ?? null);
  }
  return [];
}

/**
 * What the provider said about each product it did not rate, naming the
 * product: 'GAP: the provider says "No rates available".' A product with no
 * rates and no words gets a plain line of its own.
 */
export function providerMessages(
  response: unknown,
  nameFor: (productCode: string, label: string) => string,
): string[] {
  const vehicles = (response as { quote?: { vehicles?: unknown } } | null)?.quote?.vehicles;
  const out: string[] = [];
  for (const v of Array.isArray(vehicles) ? vehicles : []) {
    const products = (v as { products?: unknown }).products;
    for (const p of (Array.isArray(products) ? products : []) as Record<string, unknown>[]) {
      const rates = Array.isArray(p.rates) ? p.rates : [];
      const said = MESSAGE_KEYS.flatMap((k) => texts(p[k]));
      if (said.length === 0 && rates.length > 0) continue;
      const name = nameFor(String(p.unique ?? ""), String(p.label ?? p.unique ?? "A product"));
      if (said.length === 0) out.push(`${name}: the provider offered no rates for this deal.`);
      for (const s of [...new Set(said)]) out.push(`${name}: the provider says "${s}".`);
    }
  }
  return out;
}
