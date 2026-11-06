// _shared/default-deductible.ts: the deductible a product starts at.
//
// Riders Advantage confirmed that when nothing else is chosen the deductible
// is the $100 disappearing deductible (6 Nov 2026). PS starts every product
// that offers deductibles on the deductible set here, in Administration >
// Menus, "Default deductible". Kept on the tenant's record (public.tenants
// .config.default_deductible) in words, as a person reads it: "$100
// disappearing", "$50", "No deductible". Until someone saves one it is
// "$100 disappearing".
//
// In the provider's answer each deductible is its own rate line with its own
// price, told apart by "deduct.code" ("0 Ded", "50 Ded", "100 Dis Ded"),
// "deduct.type" (STD or DIS) and dealerDeduct.amount. A product whose lines
// carry no deduct.code offers no deductible choice and is never affected.
//
// Pure, so a Node test can hold it, apart from the one read at the end.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/** What it is until someone sets it. */
export const DEFAULT_DEDUCTIBLE = "$100 disappearing";

/** The choices Administration offers, in words. */
export const DEDUCTIBLE_CHOICES = ["No deductible", "$50", "$100", "$100 disappearing", "$250", "$500"] as const;

export interface DeductibleChoice {
  /** Dollars; 0 is no deductible. */
  amount: number;
  disappearing: boolean;
}

/** "$100 disappearing" to { amount: 100, disappearing: true }; null when it is not one of the choices. */
export function parseDeductible(text: unknown): DeductibleChoice | null {
  const t = String(text ?? "").trim();
  if (!(DEDUCTIBLE_CHOICES as readonly string[]).includes(t)) return null;
  if (t === "No deductible") return { amount: 0, disappearing: false };
  const m = /^\$(\d+)( disappearing)?$/.exec(t);
  return m ? { amount: Number(m[1]), disappearing: !!m[2] } : null;
}

/** The setting as stored, or the default when nothing usable is stored. */
export function defaultDeductibleOf(config: unknown): string {
  const v = (config as { default_deductible?: unknown } | null)?.default_deductible;
  return parseDeductible(v) ? String(v).trim() : DEFAULT_DEDUCTIBLE;
}

/** The tenant's setting. Read on the server; a failure reads as the default. */
export async function readDefaultDeductible(supabase: SupabaseClient, tenantId: unknown): Promise<string> {
  if (typeof tenantId !== "string") return DEFAULT_DEDUCTIBLE;
  const { data } = await supabase.from("tenants").select("config").eq("id", tenantId).maybeSingle();
  return defaultDeductibleOf((data as { config?: unknown } | null)?.config ?? null);
}

// ── Picking a rate line with it ───────────────────────────────────────────
// Whenever PS picks a product's rate line itself, because staff have not
// chosen one, a product with deductible lines starts on the line matching the
// setting, at the term PS picked. When no line at that term matches, nothing
// else is put in its place: the product waits, with noDefaultNotice, for staff
// to choose a deductible. A product without deductible lines is picked as
// before: the first line at the term. Kept equal to the app's copy
// (apps/ownership-planner/lib/default-deductible.ts).

/** What a rate line needs for the pick: its term and its deductible. */
export interface DeductibleLine {
  term_months: number | null;
  deductible: number | null;
  deductible_code?: string | null;
  disappearing_deductible?: boolean | null;
}

/**
 * The product offers a deductible: its lines carry the provider's deductible
 * code, and at least one is an actual deductible. Lines coded only "$0" (a
 * price sheet's "$0 deductible") are a product without one.
 */
export function hasDeductibleLines(rates: DeductibleLine[]): boolean {
  const coded = rates.filter((r) => typeof r.deductible_code === "string" && r.deductible_code.trim() !== "");
  return coded.some((r) => Number(r.deductible ?? 0) > 0 || !!r.disappearing_deductible);
}

/** The line is that deductible. A negative amount from the provider is read as none. */
export function isDeductible(r: DeductibleLine, d: DeductibleChoice): boolean {
  const amount = Number(r.deductible ?? 0);
  return (amount < 0 ? 0 : amount) === d.amount && !!r.disappearing_deductible === d.disappearing;
}

/** "No $100 disappearing deductible is offered for this term. Choose a deductible." */
export function noDefaultNotice(setting: string): string {
  const d = parseDeductible(setting);
  if (d && d.amount === 0) return "No option without a deductible is offered for this term. Choose a deductible.";
  return `No ${d ? setting : DEFAULT_DEDUCTIBLE} deductible is offered for this term. Choose a deductible.`;
}

/**
 * The line PS starts a product on at a term (null: any term, the first that
 * matches): the default deductible's line, or null when the product has
 * deductible lines and none at that term matches. Without deductible lines,
 * the term's first line, as before.
 */
export function defaultLineFor<R extends DeductibleLine>(rates: R[], months: number | null, setting: string): R | null {
  const inTerm = rates.filter((r) => months === null || r.term_months === months);
  if (inTerm.length === 0) return null;
  if (!hasDeductibleLines(rates)) return inTerm[0];
  const d = parseDeductible(setting) ?? parseDeductible(DEFAULT_DEDUCTIBLE)!;
  return inTerm.find((r) => isDeductible(r, d)) ?? null;
}
