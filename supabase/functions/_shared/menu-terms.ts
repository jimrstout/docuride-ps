// _shared/menu-terms.ts
//
// Payment terms on the conventional menu (docs/multi-provider.md section 26,
// migration 0046).
//
// The first term in every column is always the deal's own, from the CRM's
// finance figures (_shared/finance-basis.ts), labelled as such, and cannot be
// removed. A column may add up to two more, each with its own months and
// interest rate: from the template's presets (fni.menu_preset_terms), or as
// Prepare menu set them for the deal (sessions.menu_terms). A rate is always
// given; the deal's rate never carries to a longer term. Payments use the
// payment rules already in place (planTotals), with only the months and rate
// changed. Cash deals have a total and no payments.
//
// Extra terms are a presentation aid. When the customer chooses a package on
// another term, Details tells staff to update the deal in DX1 and the CRM.
// PS never changes the CRM's finance terms.
//
// Pure, so a Node test can hold it. apps/ownership-planner/lib/menu-terms.ts
// carries the same words for the browser.

export const MAX_EXTRA_TERMS = 2;

export interface Term {
  months: number;
  rate: number;
  /** The deal's own term and rate, from the CRM. */
  deal_term: boolean;
}

/** "5.90%", "7.74%", "6.999%". */
export function rateText(rate: number): string {
  const fixed = rate.toFixed(3).replace(/0$/, "");
  return `${fixed}%`;
}

/** "72 months at 7.74%"; the deal's own reads "60 months at 5.90%, the deal's term". */
export function termText(t: Term): string {
  const base = `${t.months} months at ${rateText(t.rate)}`;
  return t.deal_term ? `${base}, the deal's term` : base;
}

/** "$654.32 a month for 60 months at 5.90%". */
export function paymentText(monthly: number, t: Term): string {
  const dollars = `$${monthly.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${dollars} a month for ${t.months} months at ${rateText(t.rate)}`;
}

/**
 * A column's terms: the deal's first, then its extra terms, at most two, with
 * any that only repeats the deal's own left out. No deal term (a cash deal, or
 * finance figures that cannot be read): no terms at all.
 */
export function columnTerms(
  deal: { months: number | null; rate: number | null } | null,
  extras: { months: number; rate: number }[] | null | undefined
): Term[] {
  if (!deal || deal.months === null || deal.rate === null) return [];
  const out: Term[] = [{ months: deal.months, rate: deal.rate, deal_term: true }];
  for (const e of extras ?? []) {
    if (out.length > MAX_EXTRA_TERMS) break;
    if (out.some((t) => t.months === e.months && Math.abs(t.rate - e.rate) < 1e-9)) continue;
    out.push({ months: e.months, rate: e.rate, deal_term: false });
  }
  return out;
}

/** Extra terms as typed, checked. Blank pairs are no term; half a pair is refused. */
export function parseTerms(
  raw: { months?: unknown; rate?: unknown }[],
  where: string
): { terms: { months: number; rate: number }[] } | { errors: string[] } {
  const errors: string[] = [];
  const terms: { months: number; rate: number }[] = [];
  for (const r of raw.slice(0, MAX_EXTRA_TERMS + 1)) {
    const m = String(r.months ?? "").trim();
    const p = String(r.rate ?? "").trim().replace(/%$/, "");
    if (m === "" && p === "") continue;
    if (m === "" || p === "") {
      errors.push(`${where}: an extra term needs both its months and its interest rate.`);
      continue;
    }
    const months = Number(m);
    const rate = Number(p);
    if (!Number.isInteger(months) || months < 6 || months > 240) errors.push(`${where}: ${m} is not a term in months.`);
    else if (!Number.isFinite(rate) || rate < 0 || rate >= 100 || !/^\d+(\.\d{1,3})?$/.test(p)) errors.push(`${where}: ${p} is not an interest rate.`);
    else terms.push({ months, rate });
  }
  if (terms.length > MAX_EXTRA_TERMS) errors.push(`${where}: at most two extra terms, three with the deal's own.`);
  return errors.length > 0 ? { errors } : { terms };
}

/** The session event when the customer chooses a package. */
export function packageChosenEvent(name: string, term: Term | null, removed: string[]): string {
  const head = term ? `Package chosen: ${name}, ${term.months} months at ${rateText(term.rate)}.` : `Package chosen: ${name}.`;
  return removed.length > 0 ? `${head} Removed: ${removed.join(", ")}.` : head;
}

/** The note on Details when the customer chose a term other than the deal's. Null when it was the deal's. */
export function chosenTermNote(chosen: Term | null, deal: { months: number | null; rate: number | null } | null): string | null {
  if (!chosen || chosen.deal_term || !deal || deal.months === null || deal.rate === null) return null;
  return (
    `The customer chose ${chosen.months} months at ${rateText(chosen.rate)}. ` +
    `The finance terms in the CRM say ${deal.months} months at ${rateText(deal.rate)}. ` +
    `Update the deal in DX1 and the CRM before generating documents.`
  );
}
