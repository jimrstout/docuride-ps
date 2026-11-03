// fni-admin-settings/brands.ts: the admin area's Brands section.
//
// GET  ?section=brands    brands, parent-company groupings, settled spellings,
//                         and the provider's own makes list per server
// POST { section: "brands", action, ... }
//   save_brand       { id?, name, aliases, active }
//   save_group       { id?, parent_name, brand_name, vehicle_types, preferred, note }
//   remove_group     { id }
//   save_spelling    { id?, provider_id, environment, vtype, brand_name, spelling, note }
//   remove_spelling  { id }
//
// See _shared/brands.ts and migration 0056. The provider's makes list is read
// only here: rating fills it from the provider.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseBrand, parseGroup, parseSpelling } from "../_shared/brand-admin.ts";
import { VEHICLE_TYPES } from "../_shared/vehicle-types.ts";

export interface Reply {
  status: number;
  body: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readBrands(supabase: SupabaseClient, tenantId: string): Promise<Reply> {
  const [brands, groups, providers] = await Promise.all([
    supabase.schema("fni").from("brands").select("id, name, aliases, active, updated_at, updated_by").eq("tenant_id", tenantId).order("name"),
    supabase.schema("fni").from("brand_groups").select("id, parent_name, brand_name, vehicle_types, preferred, note, updated_at, updated_by")
      .eq("tenant_id", tenantId).order("parent_name").order("brand_name"),
    supabase.schema("fni").from("providers").select("id, name, adapter").eq("tenant_id", tenantId).eq("adapter", "TecAssured"),
  ]);
  for (const r of [brands, groups, providers]) {
    if (r.error) return { status: 500, body: { error: `Failed to read brands: ${r.error.message}` } };
  }
  const providerIds = ((providers.data ?? []) as { id: string }[]).map((p) => p.id);
  const [spellings, makes] = providerIds.length
    ? await Promise.all([
        supabase.schema("fni").from("brand_spellings").select("id, provider_id, environment, vtype, brand_name, spelling, source, note, checked_at, updated_by")
          .in("provider_id", providerIds).order("brand_name"),
        supabase.schema("fni").from("provider_makes").select("provider_id, environment, dealer_code, vtype, make, fetched_at")
          .in("provider_id", providerIds).order("vtype").order("make"),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  return {
    status: 200,
    body: {
      vehicle_types: VEHICLE_TYPES,
      providers: providers.data ?? [],
      brands: brands.data ?? [],
      groups: groups.data ?? [],
      spellings: spellings.data ?? [],
      provider_makes: makes.data ?? [],
    },
  };
}

export async function writeBrands(supabase: SupabaseClient, tenantId: string, body: Record<string, unknown>): Promise<Reply> {
  const who = typeof body.updated_by === "string" && body.updated_by.trim() !== "" ? body.updated_by.trim() : "staff";
  const now = new Date().toISOString();
  const id = typeof body.id === "string" && UUID.test(body.id) ? body.id : null;
  const { data: brandRows } = await supabase.schema("fni").from("brands").select("name").eq("tenant_id", tenantId);
  const brandNames = ((brandRows ?? []) as { name: string }[]).map((b) => b.name);

  if (body.action === "save_brand") {
    const parsed = parseBrand(body);
    if ("error" in parsed) return { status: 400, body: { error: parsed.error } };
    // A brand's name is fixed once saved: groupings and spellings refer to it.
    const { name, ...rest } = parsed.fields;
    const { error } = id
      ? await supabase.schema("fni").from("brands").update({ ...rest, updated_at: now, updated_by: who }).eq("id", id).eq("tenant_id", tenantId)
      : await supabase.schema("fni").from("brands").insert({ name, ...rest, tenant_id: tenantId, updated_at: now, updated_by: who });
    if (error) return { status: error.code === "23505" ? 400 : 500, body: { error: error.code === "23505" ? "That brand is already listed." : error.message } };
    return { status: 200, body: { ok: true } };
  }

  if (body.action === "save_group") {
    const parsed = parseGroup(body, brandNames);
    if ("error" in parsed) return { status: 400, body: { error: parsed.error } };
    const row = { ...parsed.fields, tenant_id: tenantId, updated_at: now, updated_by: who };
    const { error } = id
      ? await supabase.schema("fni").from("brand_groups").update(row).eq("id", id).eq("tenant_id", tenantId)
      : await supabase.schema("fni").from("brand_groups").insert(row);
    if (error) return { status: error.code === "23505" ? 400 : 500, body: { error: error.code === "23505" ? "That brand is already in that group." : error.message } };
    return { status: 200, body: { ok: true } };
  }

  if (body.action === "remove_group") {
    if (!id) return { status: 400, body: { error: "Which grouping is missing." } };
    const { error } = await supabase.schema("fni").from("brand_groups").delete().eq("id", id).eq("tenant_id", tenantId);
    if (error) return { status: 500, body: { error: error.message } };
    return { status: 200, body: { ok: true } };
  }

  if (body.action === "save_spelling" || body.action === "remove_spelling") {
    // A spelling belongs to one of this tenant's providers.
    const { data: own } = await supabase.schema("fni").from("providers").select("id").eq("tenant_id", tenantId);
    const owned = new Set(((own ?? []) as { id: string }[]).map((p) => p.id));
    if (body.action === "remove_spelling") {
      if (!id) return { status: 400, body: { error: "Which spelling is missing." } };
      const { data: row } = await supabase.schema("fni").from("brand_spellings").select("provider_id").eq("id", id).maybeSingle();
      if (!row || !owned.has((row as { provider_id: string }).provider_id)) return { status: 404, body: { error: "That spelling was not found." } };
      const { error } = await supabase.schema("fni").from("brand_spellings").delete().eq("id", id);
      if (error) return { status: 500, body: { error: error.message } };
      return { status: 200, body: { ok: true } };
    }
    const parsed = parseSpelling(body, brandNames);
    if ("error" in parsed) return { status: 400, body: { error: parsed.error } };
    if (!owned.has(parsed.fields.provider_id)) return { status: 400, body: { error: "Choose the provider." } };
    const row = { ...parsed.fields, source: "Staff", checked_at: now, updated_by: who };
    const { error } = await supabase.schema("fni").from("brand_spellings")
      .upsert(row, { onConflict: "provider_id,environment,vtype,brand_name" });
    if (error) return { status: 500, body: { error: error.message } };
    return { status: 200, body: { ok: true } };
  }

  return { status: 400, body: { error: "That is not something this page can save." } };
}
