// _shared/deal-dates.ts
//
// A deal's dates: always sent, never invented.
//
// Deal 15029 (a New MCYC) failed to rate with "The value '' cannot be parsed
// as the type 'DateTime'": the properties array follows TecAssured's required
// properties per vehicle type, MCYC does not list inservice.date, and a New
// unit makes TecAssured look for it. And the rate request used to fill a
// missing sale date with today, which is how a contract can carry the day it
// was rated instead of the day the unit was sold.
//
// So, everywhere a deal date is built or sent (the rate request, the price
// sheet adapter, the submit, the Verify sheet):
//
//   Sale date        the CRM's Sale_Date, required. Missing means no rate and
//                    no submit. Never edited in PS (_shared/crm-sale-date.ts).
//   In-service date  the session's. Missing on a New unit means the sale date;
//                    missing on a Used unit means no rate and no submit.
//
// Nothing here ever falls back to today. rateDate, the day the rate tables are
// pulled for, is the one date that is today, and it is not a deal date: it
// says when we asked. It lives in rate-request.ts, not here.

export const SALE_DATE_MISSING =
  "There is no sale date in the CRM. Add the Sale Date in the CRM.";

export const IN_SERVICE_DATE_MISSING =
  "In-service date is missing. A used unit needs the date it first went into service. " +
  "Add it on the deal and refresh from CRM, or enter it on Verify.";

/** "2026-09-26" from a date, a timestamp or "2026-09-26T...". Null when it is not one. */
export function isoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    // Another way of writing a date ("Sep 6, 2026"), read as the calendar day
    // it names, with no time zone to move it.
    if (s === "" || /^\d+$/.test(s)) return null;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const [, y, mo, d] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  const back = new Date(t);
  // 2026-02-30 is not a date.
  if (back.getUTCFullYear() !== Number(y) || back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d)) {
    return null;
  }
  return `${y}-${mo}-${d}`;
}

/** New, as opposed to Used or not known. */
export function isNewUnit(condition: unknown): boolean {
  return typeof condition === "string" && condition.trim().toLowerCase() === "new";
}

export interface DealDateSource {
  sale_date?: unknown;
  in_service_date?: unknown;
  condition?: unknown;
}

export interface DealDates {
  sale: string | null;
  inService: string | null;
  /** Why the deal cannot be rated or submitted on its dates, or null when it can. */
  problem: string | null;
}

/**
 * The dates a deal is rated and contracted on. Sale date as recorded; the
 * in-service date as recorded, or the sale date for a New unit only.
 */
export function dealDates(src: DealDateSource): DealDates {
  const sale = isoDate(src.sale_date);
  const recorded = isoDate(src.in_service_date);
  const inService = recorded ?? (isNewUnit(src.condition) ? sale : null);
  const problem = sale === null ? SALE_DATE_MISSING : inService === null ? IN_SERVICE_DATE_MISSING : null;
  return { sale, inService, problem };
}

// ── The dates on a contract ──────────────────────────────────────────────
//
// A submit sends back the rated quote, and the quote carries the deal's dates
// as TecAssured echoed them from the rate request: quote.saleDate in its own
// format ("Sep 6, 2026, 6:53:44 PM"), and sale.date / inservice.date among
// each vehicle's form properties. alignContractDates makes every one of them
// the session's own date. It changes values only; it adds nothing TecAssured
// did not send, because TecAssured echoes back whatever the rate request
// carried, and every rate request now carries both dates.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-06" as TecAssured writes a date: "Sep 6, 2026, <time>". */
export function tecAssuredDate(iso: string, time = "12:00:00 PM"): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}, ${time}`;
}

/** "Sep 6, 2026, 6:53:44 PM" to "2026-09-06". Null when it is not one. */
export function fromTecAssuredDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/);
  if (!m) return isoDate(v);
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  return isoDate(`${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`);
}

/**
 * Make the quote's dates the session's, in place. Returns one plain line per
 * value changed, for the record; empty when every date already matched.
 */
export function alignContractDates(
  quote: Record<string, unknown>,
  dates: { sale: string; inService: string }
): string[] {
  const changed: string[] = [];
  if (fromTecAssuredDate(quote.saleDate) !== dates.sale) {
    const time = typeof quote.saleDate === "string"
      ? quote.saleDate.match(/, (\d{1,2}:\d{2}:\d{2} [AP]M)$/)?.[1]
      : undefined;
    changed.push(`saleDate ${String(quote.saleDate ?? "(none)")} became ${dates.sale}`);
    quote.saleDate = tecAssuredDate(dates.sale, time);
  }
  const want: Record<string, string> = { "sale.date": dates.sale, "inservice.date": dates.inService };
  const vehicles = Array.isArray(quote.vehicles) ? quote.vehicles : [];
  for (const v of vehicles as Record<string, unknown>[]) {
    const form = v?.form as Record<string, unknown> | undefined;
    const props = Array.isArray(form?.properties) ? (form!.properties as Record<string, unknown>[]) : [];
    for (const p of props) {
      const name = String(p?.property ?? "").toLowerCase();
      if (!(name in want)) continue;
      if (isoDate(p.value) !== want[name]) {
        changed.push(`${name} ${String(p.value ?? "(none)")} became ${want[name]}`);
        p.value = want[name];
      }
    }
  }
  return changed;
}
