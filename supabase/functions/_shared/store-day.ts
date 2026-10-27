// _shared/store-day.ts
//
// A deal is sold on a day, in a store. Which day it is depends on the store's
// time zone (public.stores.time_zone, set in Administration > Stores).
//
// The session's expiry is worked out in Postgres (migration 0038:
// fni.store_day_end, fni.renew_session), so a session made by any path ends at
// the same moment. What lives here is what the Edge Functions decide with it:
//
//   the time zones a store can be given,
//   today's date in a store's zone,
//   whether a contract may be submitted on the deal's dates.
//
// Submit is allowed only on the day of the sale. A planned sale date, when one
// was set, must be that same day, and the in-service date cannot be later.

export interface TimeZoneChoice {
  zone: string;
  label: string;
}

/** The zones a store can be given, east to west. */
export const STORE_TIME_ZONES: readonly TimeZoneChoice[] = [
  { zone: "America/New_York", label: "Eastern" },
  { zone: "America/Chicago", label: "Central" },
  { zone: "America/Denver", label: "Mountain" },
  { zone: "America/Phoenix", label: "Arizona (no daylight saving)" },
  { zone: "America/Los_Angeles", label: "Pacific" },
  { zone: "America/Anchorage", label: "Alaska" },
  { zone: "Pacific/Honolulu", label: "Hawaii" },
];

export const DEFAULT_TIME_ZONE = "America/New_York";

export function isStoreTimeZone(v: unknown): v is string {
  return typeof v === "string" && STORE_TIME_ZONES.some((z) => z.zone === v);
}

/** "2026-10-27": the calendar date it is now in that zone. */
export function storeToday(timeZone: string | null | undefined, now: Date = new Date()): string {
  const zone = isStoreTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-27" as "27 Oct 2026". */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** A planned sale date that will not do, or null. It cannot be in the past. */
export function plannedDateProblem(planned: string | null, today: string): string | null {
  if (planned === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planned)) return "The planned sale date is not a date.";
  if (planned < today) return `The planned sale date cannot be in the past. Today is ${dayLabel(today)}.`;
  return null;
}

/**
 * Why a contract cannot be submitted on these dates, or null when it can.
 * The dates are the deal's own, as sent to the provider (_shared/deal-dates.ts).
 */
export function submitDateProblem(d: {
  sale: string | null;
  inService: string | null;
  planned: string | null;
  today: string;
}): string | null {
  if (d.sale === null) return null; // deal-dates.ts says so, in its own words.
  if (d.sale !== d.today) {
    return (
      `The sale date is ${dayLabel(d.sale)}. Contracts can only be submitted on the day of the sale, ` +
      `and today is ${dayLabel(d.today)} at this store. Correct the sale date on Details, or in the CRM and refresh.`
    );
  }
  if (d.planned !== null && d.planned !== d.sale) {
    return (
      `The planned sale date is ${dayLabel(d.planned)}, but the sale date is ${dayLabel(d.sale)}. ` +
      `Change the planned sale date on Details so they match.`
    );
  }
  if (d.inService !== null && d.inService > d.sale) {
    return `The in-service date (${dayLabel(d.inService)}) is after the sale date (${dayLabel(d.sale)}). Correct it on Details.`;
  }
  return null;
}
