// _shared/spent-rates.ts
//
// A rate is spent once a contract made from it has been voided, until the
// deal is rated again. "Rated again" is what ends it, not a new rate ID: a
// fresh quote may hand back the same ID, and judging by the ID alone would
// send every press of Submit back to be rated, for ever.
//
// Deal 15029, 28 Oct 2026: a contract was voided, and the next submit sent the
// same rate (34347) from the same quote. The provider refused it: "One or more
// of these products have been voided. Please re-rate and try again". In iTap,
// on the same back end, a voided contract can be written again with no
// re-rate step a person sees, so DocuRide does the same. Before the Submit
// confirmation opens, a deal with a spent rate is rated again, the same way
// staff rate it, and each spent selection is matched to the fresh offer:
//
// A fresh quote can renumber every rate, so every selection the submit will
// send is matched again, not just the spent one: one left on an old ID would
// be refused as "not found in the rated offer".
//
//   matched by   product, term months, term miles, deductible, and the
//                surcharges: every option chosen is offered, and the
//                mandatory ones are the same
//   unchanged    dealer cost, option cost and customer price identical to the
//                cent: the selection moves onto the fresh rate, and nothing
//                about its price changes
//   anything     else holds the submit, with each difference shown
//
// The customer price is the one the planner would show for the fresh rate:
// the store's pricing rules on its dealer cost, plus its options
// (_shared/plan-prices.ts), compared with the price the selection holds,
// which is the price the submit sends. Money is compared in whole cents.
//
// Pure, so a Node test can hold it.

import type { NormalizedFamily, NormalizedTier, RateVariant } from "./normalized-offer.ts";
import { customerPriceFor, surchargeCost } from "./plan-prices.ts";

export const REFRESHED_UNCHANGED_EVENT = "Rating refreshed after a void: prices unchanged";
export const REFRESHED_HELD_EVENT = "Rating refreshed after a void: prices changed, submit held";

/**
 * Rate again on Details (2026-10-28): any time, by a signed-in person. The
 * same matching, but selection by selection: one that matches to the cent
 * moves onto its fresh rate, one that does not stays where it was, out of
 * date, until staff choose again.
 */
export const RATED_AGAIN_PREFIX = "Rated again by ";
export function ratedAgainEvent(by: string): string {
  return `${RATED_AGAIN_PREFIX}${by}`;
}
export function isRatedAgainEvent(event: string): boolean {
  return event.startsWith(RATED_AGAIN_PREFIX);
}
export const OUT_OF_DATE_MESSAGE =
  "Rated again, and some products no longer match the fresh rating to the cent. Choose them again before submitting.";

export const REFRESHED_NOTE = "The rating was refreshed because an earlier contract was voided. Prices are unchanged.";
export const HELD_MESSAGE = "Prices changed since this deal was rated. Review the products on Details before submitting.";

/** A selected product, as fni.selected_products holds it. */
export interface SpentSelection {
  provider_id: string | null;
  provider_product_id: string;
  product_name: string | null;
  rate_unique_id: string | null;
  selected_options: unknown;
  customer_price: number | string | null;
  retail_price?: number | string | null;
}

/** A voided contract, as fni.agreement_products holds it. */
export interface VoidedContract {
  provider_product_id: string | null;
  rate_unique_id: string | null;
  status: string;
  voided_at: string | null;
}

/**
 * The selections whose rate a voided contract was made from, when the deal
 * has not been rated since that void. `ratedAt` is when the provider's
 * current offers were rated; null counts as long ago.
 */
export function spentSelections<T extends SpentSelection>(
  selections: T[],
  contracts: VoidedContract[],
  ratedAt: string | null
): T[] {
  const rated = ratedAt ? Date.parse(ratedAt) : NaN;
  const spent = new Set(
    contracts
      .filter((c) => c.status === "Voided" && c.rate_unique_id)
      // Rated after the void: the offers are fresh, so the rate is not spent.
      .filter((c) => !(Number.isFinite(rated) && c.voided_at && rated > Date.parse(c.voided_at)))
      .map((c) => `${c.provider_product_id ?? ""}|${c.rate_unique_id}`)
  );
  return selections.filter((s) => s.rate_unique_id !== null && spent.has(`${s.provider_product_id}|${s.rate_unique_id}`));
}

/** Whole cents, so a comparison can never be off by a fraction. */
export function cents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function chosenOf(s: SpentSelection): string[] {
  return Array.isArray(s.selected_options) ? (s.selected_options as unknown[]).map(String) : [];
}

function tierFor(families: NormalizedFamily[], s: SpentSelection): NormalizedTier | null {
  for (const f of families) {
    const t = f.tiers.find(
      (t) =>
        t.product_code === s.provider_product_id &&
        (s.provider_id === null || (t.provider_id ?? f.provider_id) === null || (t.provider_id ?? f.provider_id) === s.provider_id)
    );
    if (t) return t;
  }
  return null;
}

function mandatoryCodes(r: RateVariant): string {
  return r.options.filter((o) => o.mandatory).map((o) => o.code).sort().join(",");
}

/** The figures a product is compared on. */
export interface Figures {
  dealer_cost: number | null;
  option_cost: number;
  customer_price: number | null;
}

export interface RefreshLine {
  product_name: string;
  provider_product_id: string;
  from_rate: string | null;
  to_rate: string | null;
  /** unchanged: moves onto to_rate. changed, missing and ambiguous hold the submit. */
  status: "unchanged" | "changed" | "missing" | "ambiguous";
  old: Figures;
  new: Figures | null;
  /** The fresh rate's provider object, recorded as the selection's snapshot when it moves. */
  snapshot: Record<string, unknown> | null;
}

/**
 * Each spent selection against the fresh offer. `oldFamilies` is the quote
 * the selection was made from; `freshPriced` the fresh one, priced with the
 * store's rules.
 */
export function compareRefreshed(
  selections: SpentSelection[],
  oldFamilies: NormalizedFamily[],
  freshPriced: NormalizedFamily[]
): { lines: RefreshLine[]; unchanged: boolean } {
  const lines = selections.map((s): RefreshLine => {
    const chosen = chosenOf(s);
    const oldRate = tierFor(oldFamilies, s)?.rates.find((r) => r.rate_unique_id === s.rate_unique_id) ?? null;
    const old: Figures = {
      dealer_cost: oldRate?.dealer_cost ?? null,
      option_cost: oldRate ? surchargeCost(oldRate, chosen) : 0,
      // The price the submit sends (_shared/saved-selections.ts).
      customer_price: s.customer_price !== null && s.customer_price !== undefined ? Number(s.customer_price) : s.retail_price != null ? Number(s.retail_price) : null,
    };
    const base = {
      product_name: s.product_name ?? s.provider_product_id,
      provider_product_id: s.provider_product_id,
      from_rate: s.rate_unique_id,
      old,
    };

    const tier = tierFor(freshPriced, s);
    const candidates = !tier || !oldRate ? [] : tier.rates.filter(
      (r) =>
        r.term_months === oldRate.term_months &&
        (r.term_miles ?? 0) === (oldRate.term_miles ?? 0) &&
        cents(r.deductible) === cents(oldRate.deductible) &&
        chosen.every((code) => r.options.some((o) => o.code === code)) &&
        mandatoryCodes(r) === mandatoryCodes(oldRate)
    );
    if (candidates.length === 0) return { ...base, to_rate: null, status: "missing", new: null, snapshot: null };
    if (candidates.length > 1) return { ...base, to_rate: null, status: "ambiguous", new: null, snapshot: null };

    const fresh = candidates[0];
    const now: Figures = {
      dealer_cost: fresh.dealer_cost,
      option_cost: surchargeCost(fresh, chosen),
      customer_price: customerPriceFor(freshPriced, s.provider_product_id, fresh.rate_unique_id, chosen, s.provider_id),
    };
    const same =
      cents(now.dealer_cost) !== null && cents(now.dealer_cost) === cents(old.dealer_cost) &&
      cents(now.option_cost) === cents(old.option_cost) &&
      cents(now.customer_price) !== null && cents(now.customer_price) === cents(old.customer_price);
    return { ...base, to_rate: fresh.rate_unique_id, status: same ? "unchanged" : "changed", new: now, snapshot: fresh.raw };
  });
  return { lines, unchanged: lines.length > 0 && lines.every((l) => l.status === "unchanged") };
}

/** A line as staff read it in the confirmation. */
export function differenceText(l: Pick<RefreshLine, "product_name" | "status" | "old" | "new">, money: (n: number) => string): string {
  if (l.status === "missing") return `${l.product_name}: no longer offered.`;
  if (l.status === "ambiguous") return `${l.product_name}: more than one fresh rate matches, so it cannot be moved on its own.`;
  const parts: string[] = [];
  const pair = (label: string, a: number | null, b: number | null) => {
    if (cents(a) !== cents(b)) parts.push(`${label} ${a === null ? "none" : money(a)} to ${b === null ? "none" : money(b)}`);
  };
  pair("dealer cost", l.old.dealer_cost, l.new?.dealer_cost ?? null);
  pair("option cost", l.old.option_cost, l.new?.option_cost ?? null);
  pair("customer price", l.old.customer_price, l.new?.customer_price ?? null);
  return parts.length > 0 ? `${l.product_name}: ${parts.join(", ")}.` : `${l.product_name}: unchanged.`;
}

/** The latest refresh, as its session event holds it. */
export interface RefreshEvent {
  event: string;
  created_at: string;
  detail: { lines?: Pick<RefreshLine, "product_name" | "provider_product_id" | "from_rate" | "to_rate" | "status" | "old" | "new">[] } | null;
}

/**
 * What the Submit confirmation says about the last refresh, for the
 * selections as they now stand:
 *
 *   held       it held the submit, and the selections are still on the rates
 *              it compared: Confirm stays disabled and each difference is shown
 *   refreshed  it moved the selections, and they are still on the fresh rates:
 *              the note that prices are unchanged
 *
 * After Rate again, held while any selection that did not match is still on
 * its old rate, with only those listed.
 *
 * Null once the selections have moved on (re-presented, rated again by staff),
 * so an old refresh never speaks for a new state of the deal.
 */
export function refreshState(
  selections: { provider_product_id: string; rate_unique_id: string | null }[],
  latest: RefreshEvent | null,
  money: (n: number) => string
): { kind: "held"; differences: string[] } | { kind: "refreshed" } | null {
  const lines = latest?.detail?.lines ?? [];
  if (!latest || lines.length === 0) return null;
  const now = new Map(selections.map((s) => [s.provider_product_id, s.rate_unique_id]));
  if (latest.event === REFRESHED_HELD_EVENT) {
    const still = lines.every((l) => now.get(l.provider_product_id) === l.from_rate);
    return still
      ? { kind: "held", differences: lines.filter((l) => l.status !== "unchanged").map((l) => differenceText(l, money)) }
      : null;
  }
  if (isRatedAgainEvent(latest.event)) {
    // Selection by selection: the ones that did not match, still where they were.
    const out = lines.filter((l) => l.status !== "unchanged" && now.get(l.provider_product_id) === l.from_rate);
    return out.length > 0 ? { kind: "held", differences: out.map((l) => differenceText(l, money)) } : null;
  }
  if (latest.event === REFRESHED_UNCHANGED_EVENT) {
    return lines.every((l) => now.get(l.provider_product_id) === l.to_rate) ? { kind: "refreshed" } : null;
  }
  return null;
}
