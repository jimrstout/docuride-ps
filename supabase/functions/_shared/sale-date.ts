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

export const RATING_OUT_OF_DATE =
  "The rating is out of date because something it was rated on has changed, such as the sale date. " +
  "Press Confirm and Continue on Details to rate the deal again before submitting.";

/**
 * Why the rated offer cannot be submitted, or null.
 *
 * Out of date (a rating input moved after it was rated), or rated on a
 * different sale date than the deal now has. The second catches a moved date
 * even where nothing marked the offer out of date. An offer rated before rate
 * requests carried the sale date has none to compare, and only the first
 * check applies to it.
 */
export function staleRatingProblem(
  offer: { out_of_date?: boolean | null; request_payload?: unknown },
  saleDate: string
): string | null {
  if (offer.out_of_date === true) return RATING_OUT_OF_DATE;
  const req = offer.request_payload;
  const rated = req && typeof req === "object" ? fromTecAssuredDate((req as Record<string, unknown>).saleDate) : null;
  if (rated !== null && rated !== saleDate) {
    return (
      `The deal was rated with a sale date of ${dayLabel(rated)}, and its sale date is now ${dayLabel(saleDate)}. ` +
      `Press Confirm and Continue on Details to rate the deal again before submitting.`
    );
  }
  return null;
}
