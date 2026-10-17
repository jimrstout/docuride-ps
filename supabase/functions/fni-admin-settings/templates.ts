// fni-admin-settings/templates.ts: the admin area's Menus section.
//
// GET  ?section=templates   every menu template with its slots, the catalog's
//                           products to choose from, and the stores
// POST { section: "templates", action: "save", template_id?, ...fields, updated_by }
// POST { section: "templates", action: "add_slot", template_id, ...slot, updated_by }
// POST { section: "templates", action: "save_slot", slot_id, ...slot, updated_by }
// POST { section: "templates", action: "move_slot", slot_id, direction: "up" | "down", updated_by }
//
// A menu template decides which products a deal is offered (section 4 of
// docs/multi-provider.md). Nothing is deleted: a template is switched off, and
// a slot with no products is simply not shown.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { conditionsLine, parseSlot, parseTemplate } from "../_shared/menu-admin.ts";
import { RATEABLE_VTYPES } from "../_shared/vehicle-types.ts";
import type { Reply } from "./providers.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function context(supabase: SupabaseClient, tenantId: string) {
  const [{ data: stores, error: sErr }, { data: catalog, error: cErr }] = await Promise.all([
    supabase.from("stores").select("id, name").eq("tenant_id", tenantId).order("name"),
    supabase
      .schema("fni")
      .from("product_catalog")
      .select("id, provider_id, product_code, display_name, category, display_order, provider:providers(name)")
      .eq("tenant_id", tenantId)
      .is("store_id", null)
      .order("display_order"),
  ]);
  if (sErr) throw new Error(`Failed to read stores: ${sErr.message}`);
  if (cErr) throw new Error(`Failed to read the catalog: ${cErr.message}`);
  const products = ((catalog ?? []) as unknown as {
    id: string; provider_id: string; product_code: string; display_name: string;
    category: string; provider: { name: string } | null;
  }[]).map((c) => ({
    id: c.id,
    provider_id: c.provider_id,
    provider_name: c.provider?.name ?? "A provider",
    code: c.product_code,
    name: c.display_name,
    category: c.category,
  }));
  return { stores: (stores ?? []) as { id: string; name: string }[], products };
}

export async function readTemplates(supabase: SupabaseClient, tenantId: string): Promise<Reply> {
  const { stores, products } = await context(supabase, tenantId);
  const { data: templates, error } = await supabase
    .schema("fni")
    .from("menu_templates")
    .select("id, name, description, store_ids, deal_types, vehicle_types, conditions, makes, priority, active, updated_at, updated_by")
    .eq("tenant_id", tenantId)
    .order("priority", { ascending: false })
    .order("name");
  if (error) throw new Error(`Failed to read the menus: ${error.message}`);
  const ids = ((templates ?? []) as { id: string }[]).map((t) => t.id);
  const { data: slots } = ids.length
    ? await supabase
        .schema("fni")
        .from("menu_template_slots")
        .select("id, template_id, position, title, category, mode, product_ids")
        .in("template_id", ids)
        .order("position")
    : { data: [] };

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "a store";
  return {
    status: 200,
    body: {
      stores,
      products,
      vehicle_types: RATEABLE_VTYPES,
      templates: ((templates ?? []) as Record<string, unknown>[]).map((t) => ({
        ...t,
        conditions_line: conditionsLine(t as never, storeName),
        slots: ((slots ?? []) as { template_id: string }[]).filter((s) => s.template_id === t.id),
      })),
    },
  };
}

export async function writeTemplates(
  supabase: SupabaseClient,
  tenantId: string,
  body: Record<string, unknown>
): Promise<Reply> {
  const by = typeof body.updated_by === "string" ? body.updated_by.trim() : "";
  if (by === "") return { status: 400, body: { error: "Who is making the change is missing." } };
  const now = new Date().toISOString();
  const { stores, products } = await context(supabase, tenantId);

  /** The template a slot belongs to, refusing another tenant's. */
  const ownTemplate = async (id: unknown) => {
    if (typeof id !== "string" || !UUID.test(id)) return null;
    const { data } = await supabase.schema("fni").from("menu_templates").select("id").eq("id", id).eq("tenant_id", tenantId).maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };
  const touch = (templateId: string) =>
    supabase.schema("fni").from("menu_templates").update({ updated_at: now, updated_by: by }).eq("id", templateId);

  switch (body.action) {
    case "save": {
      const parsed = parseTemplate(body, stores.map((s) => s.id));
      if ("errors" in parsed) return { status: 400, body: { error: parsed.errors.join(" ") } };
      const row = { ...parsed.fields, updated_at: now, updated_by: by };
      const existing = body.template_id ? await ownTemplate(body.template_id) : null;
      if (body.template_id && !existing) return { status: 404, body: { error: "That menu no longer exists." } };
      const { data, error } = existing
        ? await supabase.schema("fni").from("menu_templates").update(row).eq("id", existing).select("id").single()
        : await supabase.schema("fni").from("menu_templates").insert({ ...row, tenant_id: tenantId }).select("id").single();
      if (error) {
        return error.code === "23505"
          ? { status: 400, body: { error: `There is already a menu called ${parsed.fields.name}.` } }
          : { status: 500, body: { error: error.message } };
      }
      return { status: 200, body: { template_id: (data as { id: string }).id } };
    }

    case "add_slot":
    case "save_slot": {
      const parsed = parseSlot(body, products.map((p) => p.id));
      if ("errors" in parsed) return { status: 400, body: { error: parsed.errors.join(" ") } };

      if (body.action === "add_slot") {
        const templateId = await ownTemplate(body.template_id);
        if (!templateId) return { status: 404, body: { error: "That menu no longer exists." } };
        const { data: last } = await supabase
          .schema("fni")
          .from("menu_template_slots")
          .select("position")
          .eq("template_id", templateId)
          .order("position", { ascending: false })
          .limit(1)
          .maybeSingle();
        const position = ((last as { position: number } | null)?.position ?? 0) + 1;
        const { error } = await supabase
          .schema("fni")
          .from("menu_template_slots")
          .insert({ ...parsed.fields, template_id: templateId, position, updated_at: now });
        if (error) return { status: 500, body: { error: error.message } };
        await touch(templateId);
        return { status: 200, body: { ok: true } };
      }

      if (typeof body.slot_id !== "string" || !UUID.test(body.slot_id)) {
        return { status: 400, body: { error: "Which slot is missing." } };
      }
      const { data: slot } = await supabase
        .schema("fni")
        .from("menu_template_slots")
        .select("id, template_id")
        .eq("id", body.slot_id)
        .maybeSingle();
      const s = slot as { id: string; template_id: string } | null;
      if (!s || !(await ownTemplate(s.template_id))) return { status: 404, body: { error: "That slot no longer exists." } };
      const { error } = await supabase
        .schema("fni")
        .from("menu_template_slots")
        .update({ ...parsed.fields, updated_at: now })
        .eq("id", s.id);
      if (error) return { status: 500, body: { error: error.message } };
      await touch(s.template_id);
      return { status: 200, body: { ok: true } };
    }

    case "move_slot": {
      if (typeof body.slot_id !== "string" || !UUID.test(body.slot_id)) {
        return { status: 400, body: { error: "Which slot is missing." } };
      }
      const { data: slot } = await supabase
        .schema("fni")
        .from("menu_template_slots")
        .select("id, template_id, position")
        .eq("id", body.slot_id)
        .maybeSingle();
      const s = slot as { id: string; template_id: string; position: number } | null;
      if (!s || !(await ownTemplate(s.template_id))) return { status: 404, body: { error: "That slot no longer exists." } };

      const up = body.direction === "up";
      const { data: neighbour } = await supabase
        .schema("fni")
        .from("menu_template_slots")
        .select("id, position")
        .eq("template_id", s.template_id)
        [up ? "lt" : "gt"]("position", s.position)
        .order("position", { ascending: !up })
        .limit(1)
        .maybeSingle();
      const n = neighbour as { id: string; position: number } | null;
      if (!n) return { status: 200, body: { ok: true } };

      // Swapped through a free position, because (template, position) is unique.
      const parked = -1 - s.position;
      const steps = [
        { id: s.id, position: parked },
        { id: n.id, position: s.position },
        { id: s.id, position: n.position },
      ];
      for (const step of steps) {
        const { error } = await supabase
          .schema("fni")
          .from("menu_template_slots")
          .update({ position: step.position, updated_at: now })
          .eq("id", step.id);
        if (error) return { status: 500, body: { error: error.message } };
      }
      await touch(s.template_id);
      return { status: 200, body: { ok: true } };
    }

    default:
      return { status: 400, body: { error: "Unknown action." } };
  }
}
