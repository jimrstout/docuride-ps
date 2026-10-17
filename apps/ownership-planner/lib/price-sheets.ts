// lib/price-sheets.ts: how a price sheet reads in the admin area.
//
// No Next imports, so these can be tested directly.

import type { PriceSheetRateRow, PriceSheetRow } from "./types";

/** The badge tone for a sheet's status. */
export function statusTone(s: Pick<PriceSheetRow, "status" | "parse_status">): "good" | "plain" | "warn" {
  if (s.status === "Published") return "good";
  if (s.parse_status === "Parse Failed") return "warn";
  return "plain";
}

/** "From Jan 1, 2026" or "Jan 1, 2026 to Dec 31, 2026". */
export function dateLine(s: Pick<PriceSheetRow, "effective_from" | "effective_to">): string {
  const fmt = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return s.effective_to ? `${fmt(s.effective_from)} to ${fmt(s.effective_to)}` : `From ${fmt(s.effective_from)}`;
}

const money = (v: number | string | null) => {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { style: "currency", currency: "USD" }) : null;
};

/** A rate's money in plain figures, "Not stated" when the sheet gave none. */
export function rateMoney(v: number | string | null): string {
  return money(v) ?? "Not stated";
}

/** What a rate fits, in a line: "Can-Am, UTV, New, 2024 and newer, up to 1,000 cc". */
export function fitsLine(r: PriceSheetRateRow): string {
  const parts: string[] = [];
  if (r.makes.length) parts.push(r.makes.join(" or "));
  if (r.model_contains.length) parts.push(`models with ${r.model_contains.join(" or ")}`);
  if (r.vehicle_types.length) parts.push(r.vehicle_types.join(" or "));
  if (r.conditions.length) parts.push(r.conditions.join(" or "));
  if (r.year_min !== null && r.year_max !== null) parts.push(`${r.year_min} to ${r.year_max}`);
  else if (r.year_min !== null) parts.push(`${r.year_min} and newer`);
  else if (r.year_max !== null) parts.push(`${r.year_max} and older`);
  if (r.max_age_years !== null) parts.push(`up to ${r.max_age_years} model years old`);
  if (r.max_odometer !== null) parts.push(`${r.max_odometer.toLocaleString("en-US")} or fewer on the odometer`);
  if (r.engine_cc_min !== null && r.engine_cc_max !== null) parts.push(`${r.engine_cc_min} to ${r.engine_cc_max} cc`);
  else if (r.engine_cc_min !== null) parts.push(`${r.engine_cc_min} cc and up`);
  else if (r.engine_cc_max !== null) parts.push(`up to ${r.engine_cc_max} cc`);
  if (r.max_months_in_service !== null) parts.push(`in service ${r.max_months_in_service} months or less`);
  return parts.length ? parts.join(", ") : "Any unit";
}

/** "36 months", "36 months or 12,000 miles", "Not stated". */
export function termLine(r: Pick<PriceSheetRateRow, "term_months" | "term_miles">): string {
  if (r.term_months === null) return "Not stated";
  const miles = r.term_miles ? ` or ${r.term_miles.toLocaleString("en-US")} miles` : "";
  return `${r.term_months} months${miles}`;
}
