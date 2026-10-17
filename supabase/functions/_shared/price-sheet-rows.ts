// _shared/price-sheet-rows.ts
//
// Reading a provider's Published price sheet and its rates.
//
// Price sheets arrive in Part 5 (migration 0025). Until then no provider has
// one, and saying so is the honest answer: rating a Price Sheet provider
// records "No price sheet published for BRP." for staff.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { PriceSheetRate, PublishedSheet } from "./adapters/price-sheet.ts";

/** The provider's Published sheet in force on the sale date, with its rates. */
export async function publishedSheetFor(
  _supabase: SupabaseClient,
  _providerId: string,
  _saleDate: string | null
): Promise<{ sheet: PublishedSheet | null; rates: PriceSheetRate[] }> {
  return { sheet: null, rates: [] };
}
