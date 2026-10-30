// _shared/finance-term-check.ts
//
// The chosen finance term against the CRM, part of the F&I check against DX1
// (fni-dx1-check, docs/multi-provider.md section 23).
//
// The menu can offer extra payment terms (section 26). When the customer
// chooses a package on one, the change has to be made in DX1 and brought into
// the CRM before documents are generated. This compares the term recorded on
// the session (sessions.menu_choice.term) with the CRM record fni-dx1-check
// already reads fresh:
//
//   Term_Months     integer, "Term (Months)". Must match exactly.
//   Interest_Rate   percent, "Interest Rate". Compared at two decimal places,
//                   so 7.7 and 7.70 are the same rate.
//   (field names confirmed with getFields, 2026-10-30)
//
// Nothing to compare: a cash deal, no package chosen, or a package chosen on
// the deal's own term. A difference is one blocking line; a CRM term or rate
// that cannot be read is one warnings line, and never blocks.
//
// Pure, so a Node test can hold it. PS only reads the CRM here.

import { rateText } from "./menu-terms.ts";
import { financeFigures, type FinanceSource } from "./finance-basis.ts";
import type { CheckResult } from "./dx1-check.ts";

export const TERMS_NOT_CHECKED = "Finance terms could not be checked against the CRM.";

export interface ChosenTerm {
  months: number;
  rate: number;
}

/** The term to hold the CRM to, or null when there is nothing to compare. */
export function chosenTermToCheck(s: FinanceSource & { menu_choice?: unknown }): ChosenTerm | null {
  if (!financeFigures(s).financed) return null;
  const term = (s.menu_choice as { term?: { months?: unknown; rate?: unknown; deal_term?: unknown } | null } | null)?.term;
  if (!term || term.deal_term === true) return null;
  const months = Number(term.months);
  const rate = Number(term.rate);
  if (term.months === null || term.rate === null || !Number.isInteger(months) || !Number.isFinite(rate)) return null;
  return { months, rate };
}

function readNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** A rate in hundredths of a percent, so 7.7, 7.70 and 7.699999 compare equal. */
function hundredths(rate: number): number {
  return Math.round(Number((rate * 100).toFixed(6)));
}

/**
 * The lines for the chosen term against the CRM record. A record that could
 * not be read at all is null.
 */
export function compareFinanceTerm(
  chosen: ChosenTerm | null,
  record: Record<string, unknown> | null
): { blocking: string[]; warnings: string[] } {
  if (!chosen) return { blocking: [], warnings: [] };
  const months = record ? readNumber(record.Term_Months) : null;
  const rate = record ? readNumber(record.Interest_Rate) : null;
  if (months === null || rate === null || !Number.isInteger(months)) {
    return { blocking: [], warnings: [TERMS_NOT_CHECKED] };
  }
  if (months === chosen.months && hundredths(rate) === hundredths(chosen.rate)) return { blocking: [], warnings: [] };
  return {
    blocking: [
      `Finance terms: the customer chose ${chosen.months} months at ${rateText(chosen.rate)}, ` +
        `but the CRM shows ${months} months at ${rateText(rate)}. ` +
        `Update the deal in DX1, press Update on this DocuRide record, then generate again.`,
    ],
    warnings: [],
  };
}

/**
 * The products' result with the finance term's lines added. Any blocking line
 * is "Problems"; a warning alone keeps "Nothing to check" when the products
 * had nothing to check, so a read failure never blocks.
 */
export function withFinanceTerm(base: CheckResult, term: { blocking: string[]; warnings: string[] }): CheckResult {
  if (term.blocking.length + term.warnings.length === 0) return base;
  const blocking = [...base.blocking, ...term.blocking];
  const warnings = [...base.warnings, ...term.warnings];
  const status = base.status === "Nothing to check" && blocking.length === 0 ? "Nothing to check" : "Problems";
  return { status, blocking, warnings };
}
