// lib/default-deductible.ts: the deductible a product starts at, on the app side.
//
// A copy of the picking part of supabase/functions/_shared/default-deductible.ts,
// which says how it works; test/default-deductible.test.mjs holds the two equal.
// The setting arrives with the deal (fni-session-get, fni-menu-prepare) in
// the words staff see: "$100 disappearing deductible", "$50 deductible",
// "No deductible".
//
// No imports, so a Node test can load it.

export const DEFAULT_DEDUCTIBLE = "$100 disappearing deductible";

export const DEDUCTIBLE_CHOICES = [
  "No deductible", "$50 deductible", "$100 deductible", "$100 disappearing deductible", "$250 deductible", "$500 deductible",
] as const;

export interface DeductibleChoice {
  amount: number;
  disappearing: boolean;
}

export function parseDeductible(text: unknown): DeductibleChoice | null {
  const t = String(text ?? "").trim();
  if (!(DEDUCTIBLE_CHOICES as readonly string[]).includes(t)) return null;
  if (t === "No deductible") return { amount: 0, disappearing: false };
  const m = /^\$(\d+)( disappearing)? deductible$/.exec(t);
  return m ? { amount: Number(m[1]), disappearing: !!m[2] } : null;
}

/** The setting the deal carries, or the default when it carries none. */
export function settingOf(v: unknown): string {
  return parseDeductible(v) ? String(v).trim() : DEFAULT_DEDUCTIBLE;
}

export interface DeductibleLine {
  term_months: number | null;
  deductible: number | null;
  deductible_code?: string | null;
  disappearing_deductible?: boolean | null;
}

export function hasDeductibleLines(rates: DeductibleLine[]): boolean {
  const coded = rates.filter((r) => typeof r.deductible_code === "string" && r.deductible_code.trim() !== "");
  return coded.some((r) => Number(r.deductible ?? 0) > 0 || !!r.disappearing_deductible);
}

export function isDeductible(r: DeductibleLine, d: DeductibleChoice): boolean {
  const amount = Number(r.deductible ?? 0);
  return (amount < 0 ? 0 : amount) === d.amount && !!r.disappearing_deductible === d.disappearing;
}

export function noDefaultNotice(setting: string): string {
  const d = parseDeductible(setting);
  if (d && d.amount === 0) return "No option without a deductible is offered for this term. Choose a deductible.";
  return `No ${d ? setting : DEFAULT_DEDUCTIBLE} is offered for this term. Choose a deductible.`;
}

export function defaultLineFor<R extends DeductibleLine>(rates: R[], months: number | null, setting: string): R | null {
  const inTerm = rates.filter((r) => months === null || r.term_months === months);
  if (inTerm.length === 0) return null;
  if (!hasDeductibleLines(rates)) return inTerm[0];
  const d = parseDeductible(setting) ?? parseDeductible(DEFAULT_DEDUCTIBLE)!;
  return inTerm.find((r) => isDeductible(r, d)) ?? null;
}
