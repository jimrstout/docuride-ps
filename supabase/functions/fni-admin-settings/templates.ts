// fni-admin-settings/templates.ts: the admin area's Menus section.
//
// GET  ?section=templates   every menu template with its slots, the catalog's
//                           products to choose from, and the stores
// POST { section: "templates", action: "save", template_id?, ...fields, updated_by }
// POST { section: "templates", action: "add_slot", template_id, ...slot, updated_by }
// POST { section: "templates", action: "save_slot", slot_id, ...slot, updated_by }
// POST { section: "templates", action: "move_slot", slot_id, direction: "up" | "down", updated_by }
// POST { section: "templates", action: "save_columns", template_id, columns: [...], updated_by }
// POST { section: "templates", action: "save_presets", template_id, deal_type, presets: {...},
//        updated_by, operator_id }
//
// Presets (migration 0045, _shared/menu-presets.ts): per template, Financed or
// Cash, column and category, the preferred plan, term, mileage and deductible.
// Managers only (managers.ts); everyone signed in sees them. Every change is
// logged with who and when. The GET takes ?operator_id= to say whether the
// signed-in person may change them.
//
// Each template also carries its conventional menu columns (two to five, or the
// default layout until some are saved: _shared/menu-columns.ts), and the
// section lists the catalog's products that have no approved description yet,
// so staff can write one. Such a product still appears on the conventional
// menu, under its provider product name.
//
// A menu template decides which products a deal is offered (section 4 of
// docs/multi-provider.md). Nothing is deleted: a template is switched off, and
// a slot with no products is simply not shown.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { conditionsLine, parseSlot, parseTemplate } from "../_shared/menu-admin.ts";
import { VEHICLE_TYPES } from "../_shared/vehicle-types.ts";
import { isServiceDriveName } from "../_shared/service-drive.ts";
import { columnsFor, parseColumns } from "../_shared/menu-columns.ts";
import type { Reply } from "./providers.ts";
import { CATEGORIES, DEAL_TYPES, parsePresets, presetLine, type Preset } from "../_shared/menu-presets.ts";
import { isManager, logChanges, MANAGERS_ONLY, recentChanges, type Change } from "./managers.ts";
import { parseTerms, rateText } from "../_shared/menu-terms.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function context(supabase: SupabaseClient, tenantId: string) {
  const [{ data: stores, error: sErr }, { data: catalog, error: cErr }] = await Promise.all([
    supabase.from("stores").select("id, name").eq("tenant_id", tenantId).order("name"),
    supabase
      .schema("fni")
      .from("product_catalog")
      .select("id, provider_id, product_code, display_name, category, display_order, provider_program_name, provider:providers(name)")
      .eq("tenant_id", tenantId)
      .is("store_id", null)
      .order("display_order"),
  ]);
  if (sErr) throw new Error(`Failed to read stores: ${sErr.message}`);
  if (cErr) throw new Error(`Failed to read the catalog: ${cErr.message}`);
  const products = ((catalog ?? []) as unknown as {
    id: string; provider_id: string; product_code: string; display_name: string;
    category: string; provider_program_name: string | null; provider: { name: string } | null; display_order: number | null;
  }[]).map((c) => ({
    id: c.id,
    provider_id: c.provider_id,
    provider_name: c.provider?.name ?? "A provider",
    code: c.product_code,
    name: c.display_name,
    category: c.category,
    program: c.provider_program_name,
    order: c.display_order ?? 0,
  }));
  return { stores: (stores ?? []) as { id: string; name: string }[], products };
}

/**
 * Each category's plans as the catalog names them, lowest first, for the
 * preset pickers. Service drive plans are left out: PS sells only at the time
 * of the vehicle sale (_shared/service-drive.ts).
 */
function planNames(products: { name: string; category: string; order: number }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of CATEGORIES) {
    const seen = new Map<string, number>();
    for (const p of products.filter((p) => p.category === c && !isServiceDriveName(p.name))) {
      seen.set(p.name, Math.min(seen.get(p.name) ?? Infinity, p.order));
    }
    out[c] = [...seen.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  }
  return out;
}

const PRESET_COLUMNS =
  "template_id, deal_type, column_position, category, provider_id, plan_name, term_months, term_miles, deductible, disappearing_deductible, updated_at, updated_by";

export async function readTemplates(supabase: SupabaseClient, tenantId: string, operatorId: string | null = null): Promise<Reply> {
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

  const { data: columnRows, error: colErr } = ids.length
    ? await supabase
        .schema("fni")
        .from("menu_template_columns")
        .select("template_id, position, name, preset_categories, starting_level")
        .in("template_id", ids)
    : { data: [], error: null };
  if (colErr) throw new Error(`Failed to read the menu columns: ${colErr.message}`);

  const { data: termRows, error: tErr } = ids.length
    ? await supabase.schema("fni").from("menu_preset_terms").select("template_id, column_position, slot, term_months, rate_percent").in("template_id", ids)
    : { data: [], error: null };
  if (tErr) throw new Error(`Failed to read the menu payment terms: ${tErr.message}`);

  const { data: presetRows, error: pErr } = ids.length
    ? await supabase.schema("fni").from("menu_presets").select(PRESET_COLUMNS).in("template_id", ids)
    : { data: [], error: null };
  if (pErr) throw new Error(`Failed to read the menu presets: ${pErr.message}`);

  // Products with no approved description yet, by the planner's own rule
  // (fni.product_catalog_presentable).
  const { data: unwritten, error: wErr } = await supabase
    .schema("fni")
    .from("product_catalog_presentable")
    .select("id, provider_id, product_code, display_name")
    .eq("tenant_id", tenantId)
    .is("store_id", null)
    .eq("is_presentable", false);
  if (wErr) throw new Error(`Failed to read which products need a description: ${wErr.message}`);

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "a store";
  return {
    status: 200,
    body: {
      stores,
      products,
      vehicle_types: VEHICLE_TYPES,
      plan_names: planNames(products),
      // Whether the signed-in person may change presets: managers only.
      can_edit_presets: await isManager(supabase, operatorId),
      preset_changes: await recentChanges(supabase, tenantId, "Menu preset"),
      templates: ((templates ?? []) as Record<string, unknown>[]).map((t) => ({
        ...t,
        conditions_line: conditionsLine(t as never, storeName),
        slots: ((slots ?? []) as { template_id: string }[]).filter((s) => s.template_id === t.id),
        presets: ((presetRows ?? []) as (Preset & { template_id: string })[]).filter((p) => p.template_id === t.id),
        // Extra payment terms per column, Financed deals only (migration 0046).
        preset_terms: ((termRows ?? []) as { template_id: string; column_position: number; slot: number; term_months: number | null; rate_percent: number | string | null }[])
          .filter((r) => r.template_id === t.id && r.term_months !== null && r.rate_percent !== null)
          .map((r) => ({ column_position: r.column_position, slot: r.slot, months: r.term_months!, rate: Number(r.rate_percent) })),
        menu_columns: columnsFor(
          ((columnRows ?? []) as {
            template_id: string; position: number; name: string; preset_categories: string[] | null; starting_level: string | null;
          }[]).filter((c) => c.template_id === t.id)
        ),
      })),
      needs_description: ((unwritten ?? []) as { id: string; provider_id: string; product_code: string; display_name: string }[]).map((u) => ({
        id: u.id,
        provider_id: u.provider_id,
        provider_name: products.find((p) => p.id === u.id)?.provider_name ?? "A provider",
        code: u.product_code,
        name: u.display_name,
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

    case "save_columns": {
      const templateId = await ownTemplate(body.template_id);
      if (!templateId) return { status: 404, body: { error: "That menu no longer exists." } };
      const parsed = parseColumns(body.columns);
      if ("errors" in parsed) return { status: 400, body: { error: parsed.errors.join(" ") } };
      // One statement replaces them all, and refuses fewer than two or more than five.
      const { error } = await supabase
        .schema("fni")
        .rpc("save_menu_columns", { p_template_id: templateId, p_columns: parsed.columns, p_updated_by: by });
      if (error) return { status: 400, body: { error: error.message } };
      await touch(templateId);
      return { status: 200, body: { ok: true, columns: parsed.columns.length } };
    }

    case "save_presets": {
      if (!(await isManager(supabase, body.operator_id))) return { status: 403, body: { error: MANAGERS_ONLY } };
      const templateId = await ownTemplate(body.template_id);
      if (!templateId) return { status: 404, body: { error: "That menu no longer exists." } };
      const dealType = String(body.deal_type ?? "");
      if (!(DEAL_TYPES as readonly string[]).includes(dealType)) return { status: 400, body: { error: "Choose Financed or Cash." } };
      const { data: colRows } = await supabase
        .schema("fni").from("menu_template_columns").select("position, name").eq("template_id", templateId);
      const { columns } = columnsFor((colRows ?? []) as never);
      const names = new Set(products.map((p) => p.name));
      const parsed = parsePresets((body.presets ?? {}) as Record<string, unknown>, columns.length, names);
      if ("errors" in parsed) return { status: 400, body: { error: parsed.errors.join(" ") } };

      // Payment terms: Financed only, up to two extra per column, each with a rate
      // (_shared/menu-terms.ts). Cash deals show a total and no payments.
      const termForm = (body.terms ?? {}) as Record<string, unknown>;
      const wantTerms: { column_position: number; slot: number; term_months: number | null; rate_percent: number | null }[] = [];
      if (dealType === "Financed") {
        const termErrors: string[] = [];
        for (let pos = 1; pos <= columns.length; pos++) {
          const got = parseTerms(
            [1, 2].map((slot) => ({ months: termForm[`t_${pos}_${slot}_months`], rate: termForm[`t_${pos}_${slot}_rate`] })),
            columns[pos - 1].name
          );
          if ("errors" in got) termErrors.push(...got.errors);
          else [1, 2].forEach((slot) => wantTerms.push({
            column_position: pos, slot,
            term_months: got.terms[slot - 1]?.months ?? null,
            rate_percent: got.terms[slot - 1]?.rate ?? null,
          }));
        }
        if (termErrors.length > 0) return { status: 400, body: { error: termErrors.join(" ") } };
      }

      const { data: beforeRows, error: bErr } = await supabase
        .schema("fni").from("menu_presets").select(PRESET_COLUMNS).eq("template_id", templateId).eq("deal_type", dealType);
      if (bErr) return { status: 500, body: { error: bErr.message } };
      // A cleared preset is kept as an empty row (nothing here deletes): it reads as none.
      const empty = (p: Preset) =>
        p.plan_name === null && p.term_months === null && p.term_miles === null && p.deductible === null && p.disappearing_deductible === null;
      const before = ((beforeRows ?? []) as Preset[]).filter((p) => !empty(p));
      const key = (p: Preset) => `${p.column_position}|${p.category}`;
      const same = (a: Preset, b: Preset) =>
        a.plan_name === b.plan_name && a.term_months === b.term_months && a.term_miles === b.term_miles &&
        Number(a.deductible ?? -1) === Number(b.deductible ?? -1) && a.disappearing_deductible === b.disappearing_deductible;
      const colName = (pos: number) => columns[pos - 1]?.name;
      const record = (p: Preset) => ({ line: presetLine(p, colName(p.column_position)), ...p });
      const recordKey = (p: Preset) => `${templateId}|${dealType}|${p.column_position}|${p.category}`;

      const changes: Change[] = [];
      const upserts: Preset[] = [];
      for (const p of parsed.presets) {
        const was = before.find((b) => key(b) === key(p));
        if (was && same(was, p)) continue;
        upserts.push(p);
        changes.push({ area: "Menu preset", record_key: recordKey(p), action: was ? "Changed" : "Created", before: was ? record(was) : null, after: record(p) });
      }
      const removed = before.filter((b) => !parsed.presets.some((p) => key(p) === key(b)));
      for (const r of removed) {
        changes.push({ area: "Menu preset", record_key: recordKey(r), action: "Removed", before: record(r), after: null });
      }
      // Terms that changed, logged under the presets' area with their own key.
      const { data: termRows, error: tErr } = dealType === "Financed"
        ? await supabase.schema("fni").from("menu_preset_terms").select("column_position, slot, term_months, rate_percent").eq("template_id", templateId)
        : { data: [], error: null };
      if (tErr) return { status: 500, body: { error: tErr.message } };
      const termBefore = (termRows ?? []) as { column_position: number; slot: number; term_months: number | null; rate_percent: number | string | null }[];
      const termUpserts = wantTerms.filter((w) => {
        const was = termBefore.find((b) => b.column_position === w.column_position && b.slot === w.slot);
        const wasMonths = was?.term_months ?? null;
        const wasRate = was?.rate_percent === null || was?.rate_percent === undefined ? null : Number(was.rate_percent);
        return wasMonths !== w.term_months || wasRate !== w.rate_percent;
      });
      for (const w of termUpserts) {
        const was = termBefore.find((b) => b.column_position === w.column_position && b.slot === w.slot) ?? null;
        const line = (t: { term_months: number | null; rate_percent: number | string | null } | null) =>
          t && t.term_months !== null && t.rate_percent !== null
            ? `${colName(w.column_position)}, extra term ${w.slot}: ${t.term_months} months at ${rateText(Number(t.rate_percent))}`
            : null;
        const before = was && line(was) ? { line: line(was) } : null;
        const after = line(w) ? { line: line(w) } : null;
        changes.push({
          area: "Menu preset",
          record_key: `terms|${templateId}|${w.column_position}|${w.slot}`,
          action: before === null ? "Created" : after === null ? "Removed" : "Changed",
          before,
          after,
        });
      }

      if (changes.length === 0) return { status: 200, body: { ok: true, changed: 0 } };

      // The record first: a change that cannot be logged is not made.
      try {
        await logChanges(supabase, tenantId, by, changes);
      } catch (err) {
        return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
      if (upserts.length > 0) {
        const { error } = await supabase.schema("fni").from("menu_presets").upsert(
          upserts.map((p) => ({ ...p, template_id: templateId, deal_type: dealType, updated_at: now, updated_by: by })),
          { onConflict: "template_id,deal_type,column_position,category" }
        );
        if (error) return { status: 500, body: { error: error.message } };
      }
      for (const r of removed) {
        const { error } = await supabase.schema("fni").from("menu_presets")
          .update({ plan_name: null, term_months: null, term_miles: null, deductible: null, disappearing_deductible: null, updated_at: now, updated_by: by })
          .eq("template_id", templateId).eq("deal_type", dealType).eq("column_position", r.column_position).eq("category", r.category);
        if (error) return { status: 500, body: { error: error.message } };
      }
      if (termUpserts.length > 0) {
        const { error } = await supabase.schema("fni").from("menu_preset_terms").upsert(
          termUpserts.map((w) => ({ ...w, template_id: templateId, updated_at: now, updated_by: by })),
          { onConflict: "template_id,column_position,slot" }
        );
        if (error) return { status: 500, body: { error: error.message } };
      }
      await touch(templateId);
      return { status: 200, body: { ok: true, changed: changes.length } };
    }

    default:
      return { status: 400, body: { error: "Unknown action." } };
  }
}
