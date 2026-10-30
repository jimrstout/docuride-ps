// _shared/store-day.ts
//
// A deal is sold on a day, in a store. Which day it is depends on the store's
// time zone (public.stores.time_zone, set in Administration > Stores).
//
// The session's expiry is worked out in Postgres (migrations 0038 and 0044:
// fni.store_day_end, fni.session_sale_day_end), so a session made by any path ends at
// the same moment. What lives here is what the Edge Functions decide with it:
//
//   the time zones a store can be given,
//   today's date in a store's zone,
//   whether a contract may be submitted on the deal's dates.
//
// Submit is allowed only on the CRM sale date, today at the store, and the
// in-service date cannot be later. The session is open through 23:59:59 on
// the sale date (migration 0044).

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

/**
 * Why a contract cannot be submitted on these dates, or null when it can.
 * The sale date is the CRM's (_shared/crm-sale-date.ts), read fresh just
 * before Submit; it must be today at the store. The in-service date, which
 * staff enter for a Used unit, cannot be later.
 */
export function submitDateProblem(d: {
  sale: string | null;
  inService: string | null;
  today: string;
}): string | null {
  if (d.sale === null) return null; // deal-dates.ts says so, in its own words.
  if (d.sale !== d.today) return saleDateLine(d.sale, d.today);
  if (d.inService !== null && d.inService > d.sale) {
    return `The in-service date (${dayLabel(d.inService)}) is after the sale date (${dayLabel(d.sale)}). Correct it on Details.`;
  }
  return null;
}

/** The one date line Details shows when the sale date is not today at the store. */
export function saleDateLine(sale: string, today: string): string {
  return (
    `The sale date in the CRM is ${dayLabel(sale)}. Contracts can only be submitted on the sale date, ` +
    `and today is ${dayLabel(today)} at this store. Change the Sale Date in the CRM.`
  );
}

/**
 * A live contract sent with a date other than the CRM sale date. Shown on
 * Details; nothing is changed or voided for it.
 */
export function contractDateLine(c: { name: string; contract_number: string; dated: string }, sale: string): string | null {
  if (c.dated === sale) return null;
  return (
    `${c.name} (contract ${c.contract_number}) is dated ${dayLabel(c.dated)}, but the sale date in the CRM is ` +
    `${dayLabel(sale)}. Void it and submit again on the sale date.`
  );
}
