// _shared/price-sheet-rows.ts
//
// Reading a provider's Published price sheet and its rates, for rating and for
// Verify's list of required inputs.
//
// The sheet in force is the Published one whose dates cover the sale date (or
// today, for a deal with none). Rates left out on review or flagged are never
// offered, so they are not read.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { PriceSheetRate, PublishedSheet } from "./adapters/price-sheet.ts";
import { inForceOn } from "./price-sheet-checks.ts";

const RATE_COLUMNS = [
  "id", "product_code", "product_name", "family_code", "plan", "category",
  "makes", "model_contains", "year_min", "year_max", "vehicle_types", "conditions",
  "max_age_years", "max_odometer", "engine_cc_min", "engine_cc_max",
  "max_months_in_service", "term_months", "term_miles", "deductible",
  "dealer_cost", "suggested_retail", "options", "flagged",
].join(", ");

/** Postgres numerics arrive as strings over PostgREST. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The provider's Published sheet in force on the sale date, with its rates. */
export async function publishedSheetFor(
  supabase: SupabaseClient,
  providerId: string,
  saleDate: string
): Promise<{ sheet: PublishedSheet | null; rates: PriceSheetRate[] }> {
  // The sheet in force on the day the unit was sold. Never today: a caller
  // with no sale date does not rate at all (_shared/deal-dates.ts).
  const day = saleDate.slice(0, 10);
  const { data: sheets, error } = await supabase
    .schema("fni")
    .from("price_sheets")
    .select("id, name, status, effective_from, effective_to, published_at")
    .eq("provider_id", providerId)
    .eq("status", "Published");
  if (error) throw new Error(`Failed to read the price sheets: ${error.message}`);

  const inForce = ((sheets ?? []) as unknown as {
    id: string; name: string; status: string; effective_from: string;
    effective_to: string | null; published_at: string | null;
  }[])
    .filter((s) => inForceOn(s, day))
    // Publishing retires an overlapping sheet, so there is normally one. If two
    // somehow are, the most recently published wins.
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  const sheet = inForce[0];
  if (!sheet) return { sheet: null, rates: [] };

  const { data: rows, error: rateErr } = await supabase
    .schema("fni")
    .from("price_sheet_rates")
    .select(RATE_COLUMNS)
    .eq("sheet_id", sheet.id)
    .eq("left_out", false)
    .eq("flagged", false);
  if (rateErr) throw new Error(`Failed to read ${sheet.name}'s rates: ${rateErr.message}`);

  const rates = ((rows ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as PriceSheetRate),
    deductible: num(r.deductible),
    dealer_cost: num(r.dealer_cost) ?? 0,
    suggested_retail: num(r.suggested_retail),
  }));
  return { sheet: { id: sheet.id, name: sheet.name }, rates };
}
