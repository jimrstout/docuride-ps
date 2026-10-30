// lib/menu-labels.ts: product options in plain English, for staff and customers.
//
// The same words as supabase/functions/_shared/menu-presets.ts, which the Next
// build cannot import. test/menu-presets.test.mjs holds the two equal.
//
// No imports, so a Node test can load it.

/** "4 years", "18 months", "1 year". */
export function termLabel(months: number | null | undefined): string {
  if (!months || months <= 0) return "No set term";
  if (months % 12 === 0) return months === 12 ? "1 year" : `${months / 12} years`;
  return months === 1 ? "1 month" : `${months} months`;
}

/** "Unlimited miles", "36,000 miles". */
export function milesLabel(miles: number | null | undefined): string {
  if (!miles) return "Unlimited miles";
  return `${miles.toLocaleString("en-US")} miles`;
}

/** "$100 Disappearing Deductible", "$50 Deductible", "No deductible". */
export function deductibleLabel(amount: number | null | undefined, disappearing?: boolean | null): string {
  if (!amount) return "No deductible";
  const dollars = Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
  return `${dollars} ${disappearing ? "Disappearing Deductible" : "Deductible"}`;
}

/** "4 years / Unlimited miles, $100 Disappearing Deductible". */
export function optionLabel(r: {
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  disappearing_deductible?: boolean | null;
}): string {
  return `${termLabel(r.term_months)} / ${milesLabel(r.term_miles)}, ${deductibleLabel(r.deductible, r.disappearing_deductible)}`;
}

/** The terms, mileages and deductibles a preset can name. */
export const PRESET_TERMS = [12, 24, 36, 48, 60, 72, 84, 120] as const;
export const PRESET_MILES = [0, 12000, 24000, 36000, 48000, 60000] as const;
export const PRESET_DEDUCTIBLES = [0, 50, 100, 250, 500] as const;
