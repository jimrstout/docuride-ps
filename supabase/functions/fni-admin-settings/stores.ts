// fni-admin-settings/stores.ts: the admin area's Stores section.
//
// GET  ?section=stores   every store of the dealer group: whether it uses
//                        DocuRide PS, its time zone, and any store sharing its
//                        CRM dealer
// POST { section: "stores", store_id, time_zone, updated_by }
// POST { section: "stores", store_id, uses_ps: true | false, updated_by }
//
// A store's time zone decides when its day ends: a planning session lasts to
// 23:59:59 that day, and contracts can be submitted only when the sale date is
// that day (migration 0038, _shared/store-day.ts). It is PS's own setting, kept
// in fni.ps_stores (migration 0059); public.stores is only read here, for the
// store's name and place, which come from the CRM.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DEFAULT_TIME_ZONE, isStoreTimeZone, STORE_TIME_ZONES, storeToday } from "../_shared/store-day.ts";
import { psStores } from "../_shared/ps-stores.ts";
import { storeFullName } from "../_shared/ps-access.ts";

export interface Reply {
  status: number;
  body: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function readStores(supabase: SupabaseClient, tenantId: string): Promise<Reply> {
  const [{ data, error }, settings] = await Promise.all([
    supabase.from("stores").select("id, name, zoho_store_location, zoho_dealer_id, city, state").eq("tenant_id", tenantId),
    psStores(supabase),
  ]);
  if (error) return { status: 500, body: { error: `Failed to read stores: ${error.message}` } };
  const now = new Date();
  const rows = (data ?? []) as { id: string; name: string; zoho_store_location: string | null; zoho_dealer_id: string | null; city: string | null; state: string | null }[];
  // Stores the CRM keeps as one dealer under two names: each says which other it is.
  const sameDealer = (s: (typeof rows)[number]) =>
    s.zoho_dealer_id ? rows.filter((o) => o.id !== s.id && o.zoho_dealer_id === s.zoho_dealer_id).map((o) => storeFullName(o)).sort() : [];
  return {
    status: 200,
    body: {
      time_zones: STORE_TIME_ZONES,
      stores: rows.map((s) => {
        const zone = settings.get(s.id)?.time_zone ?? DEFAULT_TIME_ZONE;
        return {
          id: s.id,
          // The full name as the CRM writes it, never the short internal one.
          name: storeFullName(s),
          place: [s.city, s.state].filter((v) => v && v.trim() !== "").join(", ") || null,
          time_zone: zone,
          uses_ps: settings.get(s.id)?.uses_ps === true,
          same_dealer: sameDealer(s),
          // What day it is there now, so the page can show the zone is right.
          today: storeToday(zone, now),
        };
      }).sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}

export async function writeStores(supabase: SupabaseClient, tenantId: string, body: Record<string, unknown>): Promise<Reply> {
  if (typeof body.store_id !== "string" || !UUID.test(body.store_id)) {
    return { status: 400, body: { error: "Which store is missing." } };
  }
  // DocuRide PS on or off for the store, saved straight away, with who.
  if (typeof body.uses_ps === "boolean") {
    const who = typeof body.updated_by === "string" ? body.updated_by.trim() : "";
    const { data: store, error: readErr } = await supabase.from("stores").select("id").eq("id", body.store_id).eq("tenant_id", tenantId).maybeSingle();
    if (readErr) return { status: 500, body: { error: readErr.message } };
    if (!store) return { status: 404, body: { error: "That store does not exist." } };
    const { error } = await supabase.schema("fni").from("ps_stores").upsert(
      { store_id: body.store_id, uses_ps: body.uses_ps, updated_at: new Date().toISOString(), updated_by: who || null },
      { onConflict: "store_id" },
    );
    if (error) return { status: 500, body: { error: error.message } };
    console.log(`fni-admin-settings store ${body.store_id} uses_ps = ${body.uses_ps} by ${who || "(not given)"}`);
    return { status: 200, body: { ok: true } };
  }
  if (!isStoreTimeZone(body.time_zone)) {
    return { status: 400, body: { error: "Choose one of the time zones listed." } };
  }
  const who = typeof body.updated_by === "string" ? body.updated_by.trim() : "";
  // The store must be this dealer group's; read only.
  const { data: store, error: readErr } = await supabase.from("stores").select("id").eq("id", body.store_id).eq("tenant_id", tenantId).maybeSingle();
  if (readErr) return { status: 500, body: { error: readErr.message } };
  if (!store) return { status: 404, body: { error: "That store does not exist." } };
  // Saved in fni.ps_stores only; public.stores.time_zone is never written.
  const { error } = await supabase.schema("fni").from("ps_stores").upsert(
    { store_id: body.store_id, time_zone: body.time_zone, updated_at: new Date().toISOString(), updated_by: who || null },
    { onConflict: "store_id" },
  );
  if (error) return { status: 500, body: { error: error.message } };
  console.log(`fni-admin-settings store ${body.store_id} time_zone = ${body.time_zone} by ${who || "(not given)"}`);
  return { status: 200, body: { ok: true } };
}
