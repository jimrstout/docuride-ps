// lib/store-time.ts: a moment in a store's own time.
//
// A session lasts to 23:59:59 on its store's day (migration 0038), so staff see
// that moment as the store's clock shows it: "11:59 PM, 27 Oct (EDT)". The
// zone is the store's (Administration > Stores); New York until one is set.
//
// No React and no Next imports, so a Node test can hold it.

const FALLBACK = "America/New_York";

function zoneOr(timeZone: string | null | undefined): string {
  if (!timeZone) return FALLBACK;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return FALLBACK;
  }
}

/** "11:59 PM, 27 Oct (EDT)", or "" for something that is not a time. */
export function storeTime(iso: string | null | undefined, timeZone: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const zone = zoneOr(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    day: "numeric",
    month: "short",
    timeZoneName: "short",
  }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod")}, ${get("day")} ${get("month")} (${get("timeZoneName")})`;
}

/** "27 Oct 2026" for "2026-10-27". */
export function dayLabel(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}
