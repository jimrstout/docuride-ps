// _shared/menu-template-rows.ts
//
// Reading menu templates, their slots and the catalog rows their slots name.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveSlots, type MenuTemplate, type ResolvedSlot, type SlotProduct, type TemplateSlot } from "./menu-templates.ts";
import type { NormalizedFamily } from "./normalized-offer.ts";

/** A tenant's templates with their slots. */
export async function templatesFor(
  supabase: SupabaseClient,
  tenantId: string
): Promise<{ templates: MenuTemplate[]; slots: TemplateSlot[] }> {
  const { data: templates, error } = await supabase
    .schema("fni")
    .from("menu_templates")
    .select("id, name, store_ids, deal_types, vehicle_types, conditions, makes, priority, active, updated_at")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(`Failed to read the menu templates: ${error.message}`);

  const ids = ((templates ?? []) as { id: string }[]).map((t) => t.id);
  if (ids.length === 0) return { templates: [], slots: [] };

  const { data: slots, error: slotErr } = await supabase
    .schema("fni")
    .from("menu_template_slots")
    .select("id, template_id, position, title, category, mode, product_ids")
    .in("template_id", ids);
  if (slotErr) throw new Error(`Failed to read the menu template slots: ${slotErr.message}`);

  return {
    templates: (templates ?? []) as unknown as MenuTemplate[],
    slots: (slots ?? []) as unknown as TemplateSlot[],
  };
}

/** The provider and product code behind each catalog id a slot names. */
export async function slotCatalog(
  supabase: SupabaseClient,
  ids: string[]
): Promise<Map<string, SlotProduct>> {
  const out = new Map<string, SlotProduct>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .schema("fni")
    .from("product_catalog")
    .select("id, provider_id, product_code")
    .in("id", [...new Set(ids)]);
  if (error) throw new Error(`Failed to read the catalog for the menu: ${error.message}`);
  for (const r of (data ?? []) as { id: string; provider_id: string; product_code: string }[]) {
    out.set(r.id, { provider_id: r.provider_id, product_code: r.product_code });
  }
  return out;
}

/**
 * A template's slots, resolved against what was offered. Null when the
 * template has no slots (or there is no template), which means the menu is
 * every offered family, as it was before templates.
 */
export async function resolvedSlotsFor(
  supabase: SupabaseClient,
  templateId: string | null,
  offered: NormalizedFamily[]
): Promise<ResolvedSlot[] | null> {
  if (!templateId) return null;
  const { data, error } = await supabase
    .schema("fni")
    .from("menu_template_slots")
    .select("id, template_id, position, title, category, mode, product_ids")
    .eq("template_id", templateId);
  if (error) throw new Error(`Failed to read the menu's slots: ${error.message}`);
  const slots = (data ?? []) as unknown as TemplateSlot[];
  if (slots.length === 0) return null;
  return resolveSlots(slots, offered, await slotCatalog(supabase, slots.flatMap((sl) => sl.product_ids)));
}
