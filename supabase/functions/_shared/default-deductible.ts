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
