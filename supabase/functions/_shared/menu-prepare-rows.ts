// _shared/menu-prepare-rows.ts
//
// Everything a deal's prepared menu is built from, read in one place: the
// current rated offers (through the menu template's slots), the pricing rules,
// the catalog, the template's columns with the deal's levels, the presets for
// the deal's type (Financed or Cash), the deal's own prices, surcharges and
// prepared cells, and the products a live contract holds. Prepare menu
// (fni-menu-prepare) and Present menu (fni-session-get) both read it, so the
// two cannot disagree. See _shared/menu-prepare.ts.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { offerRowsFor } from "./provider-rows.ts";
import { currentRows, familiesFromRows, ratingSummary, type RatingRow } from "./rating-summary.ts";
import { resolvedSlotsFor } from "./menu-template-rows.ts";
import { slotFamilies } from "./menu-templates.ts";
import type { NormalizedFamily } from "./normalized-offer.ts";
import type { PricingRule } from "./planner-pricing.ts";
import { priceFamilies } from "./plan-prices.ts";
import { columnsFor, isLevel } from "./menu-columns.ts";
import { presetDealType, type Preset } from "./menu-presets.ts";
import { PURCHASED_STATES } from "./purchased.ts";
import { buildSheet, type DealPrice, type PrepareSheet, type SheetInput } from "./menu-prepare.ts";

export interface SheetLoad {
  input: SheetInput;
  sheet: PrepareSheet;
  /** The rating is out of date: there is nothing current to prepare. */
  out_of_date: boolean;
}

export async function loadSheet(supabase: SupabaseClient, s: Record<string, unknown>): Promise<SheetLoad> {
  const sessionId = String(s.id);
  const rows = currentRows(
    (await offerRowsFor(supabase, sessionId)) as unknown as RatingRow[],
    s.rated_provider_ids as string[] | null
  );
  const outOfDate = ratingSummary(rows).out_of_date;
  let families: NormalizedFamily[] = outOfDate ? [] : familiesFromRows(rows);
  const templateId = typeof s.menu_template_id === "string" ? s.menu_template_id : null;
  if (families.length > 0) {
    const resolved = await resolvedSlotsFor(supabase, templateId, families);
    if (resolved) families = slotFamilies(resolved);
  }

  const [{ data: ruleRows }, { data: catalogRows }, { data: columnRows }, { data: presetRows }, { data: priceRows }, { data: agreements }] =
    await Promise.all([
      supabase.schema("fni").from("pricing_rules").select("*")
        .eq("tenant_id", s.tenant_id as string).or(`store_id.eq.${s.store_id},store_id.is.null`).eq("active", true),
      supabase.schema("fni").from("product_catalog").select("provider_id, product_code, display_name, category, display_order")
        .eq("tenant_id", s.tenant_id as string).is("store_id", null),
      templateId
        ? supabase.schema("fni").from("menu_template_columns").select("position, name, preset_categories, starting_level").eq("template_id", templateId)
        : Promise.resolve({ data: [] }),
      templateId
        ? supabase.schema("fni").from("menu_presets").select("*").eq("template_id", templateId).eq("deal_type", presetDealType(s.finance_type))
        : Promise.resolve({ data: [] }),
      supabase.schema("fni").from("session_menu_prices").select("option_key, retail_price, above_band, approved_by, reason").eq("session_id", sessionId),
      supabase.schema("fni").from("agreements").select("id").eq("session_id", sessionId),
    ]);

  const rules = (ruleRows ?? []) as unknown as PricingRule[];
  const priced = priceFamilies(families, rules);

  const levels = (s.menu_column_levels ?? {}) as Record<string, unknown>;
  const columns = columnsFor((columnRows ?? []) as never).columns.map((c, i) => {
    const level = levels[String(i + 1)];
    return isLevel(level) ? { ...c, starting_level: level } : c;
  });

  const presets = ((presetRows ?? []) as Preset[])
    .filter((p) => p.plan_name !== null || p.term_months !== null || p.term_miles !== null || p.deductible !== null || p.disappearing_deductible !== null)
    .map((p) => ({ ...p, deductible: p.deductible === null ? null : Number(p.deductible) }));

  const prices: Record<string, DealPrice> = {};
  for (const r of (priceRows ?? []) as (DealPrice & { option_key: string })[]) {
    prices[r.option_key] = { retail_price: Number(r.retail_price), above_band: r.above_band, approved_by: r.approved_by, reason: r.reason };
  }

  const ids = ((agreements ?? []) as { id: string }[]).map((a) => a.id);
  const { data: contracts } = ids.length
    ? await supabase.schema("fni").from("agreement_products").select("provider_id, provider_product_id, status").in("agreement_id", ids)
    : { data: [] };
  const purchased = new Set(
    ((contracts ?? []) as { provider_id: string | null; provider_product_id: string | null; status: string }[])
      .filter((c) => (PURCHASED_STATES as readonly string[]).includes(c.status) && c.provider_product_id)
      .map((c) => `${c.provider_id ?? ""}:${c.provider_product_id}`)
  );
  const { data: chosen } = purchased.size
    ? await supabase.schema("fni").from("selected_products").select("provider_id, provider_product_id, customer_price, retail_price")
        .eq("session_id", sessionId).eq("disposition", "Included")
    : { data: [] };
  const purchasedPrices: Record<string, number> = {};
  for (const c of (chosen ?? []) as { provider_id: string | null; provider_product_id: string; customer_price: number | null; retail_price: number | null }[]) {
    const k = `${c.provider_id ?? ""}:${c.provider_product_id}`;
    if (purchased.has(k)) purchasedPrices[k] = Number(c.customer_price ?? c.retail_price ?? 0);
  }

  const input: SheetInput = {
    families: priced,
    catalog: (catalogRows ?? []) as never,
    rules,
    columns,
    presets,
    prepared: (s.menu_prepared ?? null) as SheetInput["prepared"],
    prices,
    surcharges: Array.isArray(s.menu_surcharges) ? (s.menu_surcharges as string[]) : [],
    purchased,
    purchased_prices: purchasedPrices,
  };
  return { input, sheet: buildSheet(input), out_of_date: outOfDate };
}
