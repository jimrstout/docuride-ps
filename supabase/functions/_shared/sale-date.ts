// _shared/sale-date.ts
//
// What follows from a sale date that moved.
//
// The sale date is the CRM's Sale_Date, the only one (docs section 24,
// _shared/crm-sale-date.ts). PS never edits it: the staff sale date, the
// planned sale date and Renew for Today are retired (migration 0044). When the
// CRM's date changes, the month rule below decides whether the deal is rated
// again.
//
// ── A sale date in another month makes the rating out of date ─────────────
// The sale date is sent in the rate request. Rate cards change at month
// boundaries, so a quote rated for 27 Oct still stands for 28 Oct, but not for
// 3 Nov: the rated offers are marked out of date and Submit refuses until the
// deal is rated again (staleRatingProblem). Nothing here touches a price.
//
// Pure, with no remote imports, so a Node test can hold it.

import { dayLabel } from "./store-day.ts";
import { fromTecAssuredDate, isoDate } from "./deal-dates.ts";

/** Who an action is recorded against when nobody is signed in. */
export const SYSTEM = "System";

/**
 * The person's initials as recorded, or System. Letters only, at most four,
 * so whatever arrives cannot be anything but initials on the record.
 */
export function renewedBy(raw: unknown): string {
  if (typeof raw !== "string") return SYSTEM;
  const v = raw.trim().toUpperCase();
  return /^[A-Z]{1,4}$/.test(v) ? v : SYSTEM;
}

// ── Within the month, the rating stands (2026-10-28) ──────────────────────
//
// Jim's rule: rate cards change at month boundaries, so a sale date moved
// within the same calendar month does not need a re-rate. A move into another
// month or year does. Sale dates are calendar days, so the month is the
// date's own.
//
// A Price Sheet provider's sheet can start or end on any day, so a move
// across one of those days is treated like a month boundary: the sheet in
// force, and so the price, may differ (_shared/price-sheet-rows.ts).

/** "2026-10" for any date in October 2026, or null. */
export function monthOf(v: unknown): string | null {
  return isoDate(v)?.slice(0, 7) ?? null;
}

/** The day after an ISO date. */
function dayAfter(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The days on which a price sheet takes over or stops: each sheet's first
 * day, and the day after its last.
 */
export function priceSheetBoundaries(sheets: { effective_from: string; effective_to: string | null }[]): string[] {
  const out = new Set<string>();
  for (const sh of sheets) {
    const from = isoDate(sh.effective_from);
    if (from) out.add(from);
    const to = isoDate(sh.effective_to);
    if (to) out.add(dayAfter(to));
  }
  return [...out].sort();
}

/**
 * Does moving the sale date from one day to another need a re-rate? Yes when
 * the month or year differs, when a price sheet boundary lies between them,
 * or when either is missing and they differ. `boundaries` null means they
 * could not be read, and the safe answer is yes.
 */
export function saleDateMoveNeedsRerate(
  from: unknown,
  to: unknown,
  boundaries: string[] | null = []
): boolean {
  const a = isoDate(from);
  const b = isoDate(to);
  if (a === b) return false;
  if (a === null || b === null) return true;
  if (monthOf(a) !== monthOf(b)) return true;
  if (boundaries === null) return true;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return boundaries.some((d) => d > lo && d <= hi);
}

/**
 * The rating inputs that moved are only the sale date, within the month, and
 * the in-service date following it (a New unit's in-service date is its sale
 * date). Such a move leaves the deal verified and its rating current; anything
 * else in the list is handled as before. Values are as the sheet shows them.
 */
export function onlySameMonthSaleDateMove(
  changed: string[],
  before: Record<string, string | null> | null | undefined,
  after: Record<string, string | null>,
  boundaries: string[] | null = []
): boolean {
  if (!before || !changed.includes("sale_date")) return false;
  if (!changed.every((k) => k === "sale_date" || k === "in_service_date")) return false;
  if (changed.includes("in_service_date")) {
    const followed =
      isoDate(before.in_service_date) === isoDate(before.sale_date) &&
      isoDate(after.in_service_date) === isoDate(after.sale_date);
    if (!followed) return false;
  }
  return !saleDateMoveNeedsRerate(before.sale_date, after.sale_date, boundaries);
}

/**
 * The session event when a test session on the QA server submits on an
 * out-of-date rating, which only a test session may do (fni-contract-submit).
 */
export const STALE_TEST_SUBMIT_EVENT = "Submitted on an out-of-date rating: test session";

/** What Details and the Submit confirmation say on such a session. */
export const STALE_TEST_NOTE = "The rating is out of date. This is a test session, so you can still submit.";

export const RATING_OUT_OF_DATE =
  "The rating is out of date because something it was rated on has changed, such as the sale date. " +
  "Press Confirm and Continue on Details to rate the deal again before submitting.";

/**
 * Why the rated offer cannot be submitted, or null.
 *
 * Out of date (a rating input moved after it was rated), or rated on a sale
 * date in a different calendar month or year than the deal now has. The
 * second catches a moved date even where nothing marked the offer out of
 * date. Within the same month the rating stands, and the submit sends the
 * quote with the deal's current dates (alignContractDates), as it did before.
 * An offer rated before rate requests carried the sale date has none to
 * compare, and only the first check applies to it.
 */
export function staleRatingProblem(
  offer: { out_of_date?: boolean | null; request_payload?: unknown },
  saleDate: string
): string | null {
  if (offer.out_of_date === true) return RATING_OUT_OF_DATE;
  const req = offer.request_payload;
  const rated = req && typeof req === "object" ? fromTecAssuredDate((req as Record<string, unknown>).saleDate) : null;
  if (rated !== null && saleDateMoveNeedsRerate(rated, saleDate)) {
    return (
      `The deal was rated with a sale date of ${dayLabel(rated)}, and its sale date is now ${dayLabel(saleDate)}, ` +
      `in another month. Rates can change from one month to the next, so press Confirm and Continue on Details ` +
      `to rate the deal again before submitting.`
    );
  }
  return null;
}

// ── Existing sessions (2026-10-28) ────────────────────────────────────────
//
// Offers marked out of date before the same-month rule are brought into line
// once (supabase/migrations/0039_same_month_rating_current.sql). The question
// for each is the one PR 53 asks going forward, asked of what the offer was
// actually rated on: rebuild today's rate request from the session as it now
// stands, holding the provider's own choices (dealer code, vehicle type code,
// the properties it asked for, the rate date) at the stored request's, and
// compare. Only a sale date moved within its month may differ.

/** The top-level request fields and properties that carry the deal's dates. */
const SALE_FIELDS = new Set(["saleDate", "vehiclePurchaseDate", "prop:sale.date"]);
const IN_SERVICE_FIELDS = new Set(["inServiceDate", "prop:inservice.date"]);

function flatRequest(req: unknown): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!req || typeof req !== "object") return out;
  for (const [k, v] of Object.entries(req as Record<string, unknown>)) {
    if (k === "rateDate") continue; // when we asked, not the deal
    if (k === "properties" && Array.isArray(v)) {
      for (const p of v as Record<string, unknown>[]) {
        const name = String(p?.name ?? p?.property ?? "").toLowerCase();
        if (name) out.set(`prop:${name}`, p?.value === null || p?.value === undefined ? null : String(p.value));
      }
      continue;
    }
    out.set(k, v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return out;
}

export interface RatedRequestDiff {
  /** Every field that differs, top level by name and properties as prop:<name>. */
  differs: string[];
  /** The offer may be marked current: only the sale date moved, within its month. */
  keepCurrent: boolean;
  rated_sale: string | null;
  current_sale: string | null;
}

/**
 * Compare the request an offer was rated on with the one the session would
 * send now. The in-service date counts as part of the sale date's move only
 * when it equalled the sale date on both sides (a New unit's follows it).
 */
export function ratedRequestDiff(
  stored: unknown,
  current: unknown,
  boundaries: string[] | null = []
): RatedRequestDiff {
  const a = flatRequest(stored);
  const b = flatRequest(current);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const differs = keys.filter((k) => (a.get(k) ?? null) !== (b.get(k) ?? null));
  const rated_sale = isoDate(a.get("saleDate"));
  const current_sale = isoDate(b.get("saleDate"));
  const followed =
    isoDate(a.get("inServiceDate")) === rated_sale && isoDate(b.get("inServiceDate")) === current_sale &&
    isoDate(a.get("prop:inservice.date") ?? a.get("inServiceDate")) === rated_sale &&
    isoDate(b.get("prop:inservice.date") ?? b.get("inServiceDate")) === current_sale;
  const onlyDates = differs.every((k) => SALE_FIELDS.has(k) || (IN_SERVICE_FIELDS.has(k) && followed));
  const keepCurrent =
    differs.includes("saleDate") && onlyDates && !saleDateMoveNeedsRerate(rated_sale, current_sale, boundaries);
  return { differs, keepCurrent, rated_sale, current_sale };
}

/** "Rating kept current: sale date moved within the same month (27 Oct 2026 to 28 Oct 2026)". */
export function keptCurrentEvent(from: string, to: string): string {
  return `Rating kept current: sale date moved within the same month (${dayLabel(from)} to ${dayLabel(to)})`;
}
