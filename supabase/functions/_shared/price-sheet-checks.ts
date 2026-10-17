// _shared/price-sheet-checks.ts
//
// The server's checks on a parsed price sheet, and the rules for publishing it.
// See docs/multi-provider.md, section 6.
//
// The checks flag, never drop. A row Claude read wrongly is still the record of
// what it read, and staff fix or delete it on review; dropping it would hide the
// mistake. A sheet with any flagged row cannot be published.
//
// Pure, so a Node test can hold every rule to account.

import { RATEABLE_VTYPES } from "./vehicle-types.ts";

/** A rate as it is checked: the price_sheet_rates columns the checks read. */
export interface CheckedRate {
  product_code: string;
  product_name: string;
  makes: string[];
  model_contains: string[];
  year_min: number | null;
  year_max: number | null;
  vehicle_types: string[];
  conditions: string[];
  engine_cc_min: number | null;
  engine_cc_max: number | null;
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  dealer_cost: number | null;
  suggested_retail: number | null;
  confidence: "High" | "Medium" | "Low";
  model_note: string | null;
  flagged: boolean;
  flag_reason: string | null;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** Every reason a row looks wrong, in plain English. Empty when it looks right. */
export function rowProblems(r: CheckedRate): string[] {
  const out: string[] = [];
  if (r.product_code.trim() === "") out.push("It has no product code.");
  if (r.product_name.trim() === "") out.push("It has no product name.");

  if (r.dealer_cost === null) out.push("The dealer cost is missing.");
  else if (r.dealer_cost <= 0) out.push(`The dealer cost of ${money(r.dealer_cost)} is not more than zero.`);
  if (r.suggested_retail !== null && r.dealer_cost !== null && r.suggested_retail < r.dealer_cost) {
    out.push(`The suggested retail of ${money(r.suggested_retail)} is below the dealer cost.`);
  }

  if (r.term_months === null) out.push("The term in months is missing.");
  else if (r.term_months < 1 || r.term_months > 120) {
    out.push(`A term of ${r.term_months} months is outside 1 to 120.`);
  }
  if (r.term_miles !== null && (r.term_miles < 0 || r.term_miles > 300000)) {
    out.push(`A term of ${r.term_miles.toLocaleString("en-US")} miles is outside 0 to 300,000.`);
  }
  if (r.deductible !== null && (r.deductible < 0 || r.deductible > 5000)) {
    out.push(`A deductible of ${money(r.deductible)} is outside $0 to $5,000.`);
  }

  if (r.year_min !== null && r.year_max !== null && r.year_min > r.year_max) {
    out.push(`The model years run backwards, ${r.year_min} to ${r.year_max}.`);
  }
  if (r.engine_cc_min !== null && r.engine_cc_max !== null && r.engine_cc_min > r.engine_cc_max) {
    out.push(`The engine sizes run backwards, ${r.engine_cc_min} to ${r.engine_cc_max} cc.`);
  }
  const unknown = r.vehicle_types.filter((v) => !RATEABLE_VTYPES.includes(v));
  if (r.vehicle_types.length > 0 && unknown.length === r.vehicle_types.length) {
    out.push(`It matches no vehicle type we rate: ${unknown.join(", ")}.`);
  } else if (unknown.length > 0) {
    out.push(`Vehicle type ${unknown.join(", ")} is not one we rate.`);
  }
  if (r.makes.length === 0) {
    out.push("It names no make, so it would be offered on every brand.");
  }

  if (r.confidence === "Low") {
    out.push(`The reading was not sure${r.model_note ? `: ${r.model_note}` : "."}`);
  }
  return out;
}

/** What makes two rows the same offer. */
function signature(r: CheckedRate): string {
  const sorted = (l: string[]) => [...l].map((s) => s.toLowerCase()).sort().join("|");
  return [
    r.product_code.toLowerCase(), r.term_months, r.term_miles, r.deductible,
    sorted(r.makes), sorted(r.model_contains), r.year_min, r.year_max,
    sorted(r.vehicle_types), sorted(r.conditions), r.engine_cc_min, r.engine_cc_max,
  ].join("~");
}

/**
 * The rows with the checks applied: each problem becomes a flag reason, and a
 * row that repeats an earlier one is flagged as a duplicate. A reason staff
 * already gave is kept.
 */
export function checkRates<T extends CheckedRate>(rows: T[]): T[] {
  const seen = new Map<string, number>();
  return rows.map((r, i) => {
    const problems = rowProblems(r);
    const sig = signature(r);
    const first = seen.get(sig);
    if (first !== undefined) {
      problems.push(`It repeats row ${first + 1}: same product, term, deductible and eligibility.`);
    } else {
      seen.set(sig, i);
    }
    const kept = r.flagged && r.flag_reason ? [r.flag_reason] : [];
    const reasons = [...new Set([...kept, ...problems])];
    return { ...r, flagged: reasons.length > 0, flag_reason: reasons.length > 0 ? reasons.join(" ") : null };
  });
}

export interface SheetForPublish {
  id: string;
  name: string;
  status: string;
  parse_status: string;
  effective_from: string;
  effective_to: string | null;
}

/**
 * Why the sheet cannot be published, or null when it can. A rate left out on
 * review does not count: it is kept as a record and never offered.
 */
export function publishRefusal(
  sheet: SheetForPublish,
  allRows: { flagged: boolean; left_out?: boolean }[]
): string | null {
  const rows = allRows.filter((r) => !r.left_out);
  if (sheet.status === "Published") return `"${sheet.name}" is already published.`;
  if (sheet.status === "Retired") return `"${sheet.name}" is retired. Upload it again to publish it.`;
  if (sheet.parse_status !== "Parsed") {
    return `"${sheet.name}" has not been read yet, so there is nothing to publish.`;
  }
  if (rows.length === 0) return `"${sheet.name}" has no rates to publish.`;
  const flagged = rows.filter((r) => r.flagged).length;
  if (flagged > 0) {
    return `"${sheet.name}" has ${flagged} flagged ${flagged === 1 ? "rate" : "rates"}. Correct ${flagged === 1 ? "it" : "them"}, or leave ${flagged === 1 ? "it" : "them"} out, before publishing.`;
  }
  return null;
}

/** The two sheets' effective dates overlap. A null end runs on for ever. */
export function datesOverlap(
  a: { effective_from: string; effective_to: string | null },
  b: { effective_from: string; effective_to: string | null }
): boolean {
  const aEnd = a.effective_to ?? "9999-12-31";
  const bEnd = b.effective_to ?? "9999-12-31";
  return a.effective_from <= bEnd && b.effective_from <= aEnd;
}

/** The sheet in force on a date: Published, and its dates cover the day. */
export function inForceOn(
  sheet: { status: string; effective_from: string; effective_to: string | null },
  day: string
): boolean {
  return (
    sheet.status === "Published" &&
    sheet.effective_from <= day &&
    (sheet.effective_to === null || day <= sheet.effective_to)
  );
}
