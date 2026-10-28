// _shared/sale-date.ts
//
// What Renew for Today does to a deal's dates, and what follows from a sale
// date that moved.
//
// ── Renew for Today moves past dates to today ─────────────────────────────
// A session renewed the morning after it was prepared still said yesterday,
// and Submit refuses anything but the day of the sale (_shared/store-day.ts).
// So Renew for Today first compares the session's sale date and planned sale
// date with today at the store:
//
//   before today   moved to today
//   today or later left alone: a deal prepared for tomorrow keeps tomorrow
//   not set        left alone: a planned sale date that was never set stays
//                  empty, and a missing sale date is still missing
//
// and then renews the session to 23:59:59 on the store's day, as before. The
// in-service date is never touched.
//
// ── The new sale date is a staff edit ─────────────────────────────────────
// The same layer as every other correction (_shared/staff-edits.ts,
// _shared/contract-parties.ts): the column keeps what the CRM says, so a
// Refresh from CRM never overwrites the moved date. While the CRM still holds
// a different date, Details shows "CRM now says ..." with Keep staff value and
// Use CRM value. Keeping records which CRM date was kept over, so the choice
// is not asked again until the CRM changes.
//
// ── A moved sale date makes the rating out of date ────────────────────────
// The sale date is sent in the rate request. A quote rated on 27 Oct is not a
// quote for 28 Oct, so the rated offers are marked out of date and Submit
// refuses until the deal is rated again (staleRatingProblem). Nothing here
// touches a price.
//
// Pure, with no remote imports, so a Node test can hold it.

import { dayLabel } from "./store-day.ts";
import { fromTecAssuredDate, isoDate } from "./deal-dates.ts";
import type { StaffEdit, StaffEdits } from "./staff-edits.ts";

/** Who a renew is recorded against when nobody is signed in. */
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

export type MovedDate = "sale_date" | "planned_sale_date";

export interface DateMove {
  field: MovedDate;
  label: "Sale date" | "Planned sale date";
  from: string;
  to: string;
}

/** Which of the two dates Renew for Today moves, sale date first. */
export function renewDateMoves(d: { sale: string | null; planned: string | null; today: string }): DateMove[] {
  const out: DateMove[] = [];
  const sale = isoDate(d.sale);
  const planned = isoDate(d.planned);
  if (sale !== null && sale < d.today) out.push({ field: "sale_date", label: "Sale date", from: sale, to: d.today });
  if (planned !== null && planned < d.today) {
    out.push({ field: "planned_sale_date", label: "Planned sale date", from: planned, to: d.today });
  }
  return out;
}

/**
 * Renewing would give the session longer: the end of the store's day (or of
 * the planned sale date) is later than the expiry it has. Only then is the
 * expiry written, so renewing a session already open to tonight leaves its
 * open-until time as it is.
 */
export function renewExtends(expiresAt: string | null | undefined, renewTo: string | null | undefined): boolean {
  if (!renewTo) return false;
  const target = Date.parse(renewTo);
  if (!Number.isFinite(target)) return false;
  const current = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  return !Number.isFinite(current) || target > current;
}

/**
 * Whether Renew for Today is offered, judged in the store's time zone: when
 * it would give the session longer, or when it would move a past sale date or
 * planned sale date to today. A session already open to tonight with
 * yesterday's sale date still needs it, or that date can never be moved.
 */
export function renewOffered(d: {
  expiresAt: string | null | undefined;
  renewTo: string | null | undefined;
  sale: string | null;
  planned: string | null;
  today: string;
}): boolean {
  return renewExtends(d.expiresAt, d.renewTo) || renewDateMoves(d).length > 0;
}

/** "Sale date moved from 27 Oct 2026 to 28 Oct 2026 by JS". */
export function dateMoveEvent(m: DateMove, who: string): string {
  return `${m.label} moved from ${dayLabel(m.from)} to ${dayLabel(m.to)} by ${who}`;
}

/**
 * The staff edit that puts the sale date on today. Its original is what the
 * CRM says, the value the sheet shows when there is no edit.
 */
export function movedSaleDateEdit(crmSaleDate: unknown, today: string, who: string, now: string): StaffEdit {
  const crm = isoDate(crmSaleDate);
  return {
    value: today,
    original: crm,
    original_source: crm === null ? "Missing" : "CRM",
    edited_by: who,
    edited_at: now,
  };
}

/** A staff sale date the CRM disagrees with, for Keep staff value / Use CRM value. */
export interface SaleDateChoice {
  staff_value: string;
  crm_value: string;
  edited_by: string;
  edited_at: string;
}

/**
 * Shown while the CRM holds a sale date other than the staff one, unless
 * staff already chose to keep theirs over that very CRM date.
 */
export function saleDateChoice(row: Record<string, unknown>, edits: StaffEdits): SaleDateChoice | null {
  const edit = edits.sale_date;
  if (!edit) return null;
  const staff = isoDate(edit.value);
  const crm = isoDate(row.sale_date);
  if (staff === null || crm === null || staff === crm) return null;
  if (edit.crm_kept === crm) return null;
  return { staff_value: staff, crm_value: crm, edited_by: edit.edited_by, edited_at: edit.edited_at };
}

/** Keep staff value: the edit stands, and records the CRM date it was kept over. */
export function keepStaffSaleDate(edit: StaffEdit, crmSaleDate: unknown, who: string, now: string): StaffEdit {
  return { ...edit, crm_kept: isoDate(crmSaleDate), edited_by: who, edited_at: now };
}

// ── Within the month, the rating stands (2026-10-28) ──────────────────────
//
// Jim's rule: rate cards change at month boundaries, so a sale date moved
// within the same calendar month does not need a re-rate. A move into another
// month or year does. Sale dates are calendar days, so the month is the
// date's own; the store's time zone decides it through "today", which is
// where Renew for Today moves a date to (storeToday).
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
