// fni-admin-settings/stores.ts: the admin area's Stores section.
//
// GET  ?section=stores   every store of the dealer group, with its time zone
// POST { section: "stores", store_id, time_zone, updated_by }
//
// A store's time zone decides when its day ends: a planning session lasts to
// 23:59:59 that day, and contracts can be submitted only when the sale date is
// that day (migration 0038, _shared/store-day.ts). It is PS's own setting, kept
// in fni.ps_stores (migration 0059); public.stores is only read here, for the
// store's name and place, which come from the CRM.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DEFAULT_TIME_ZONE, isStoreTimeZone, STORE_TIME_ZONES, storeToday } from "../_shared/store-day.ts";
import { psStores } from "../_shared/ps-stores.ts";

export interface Reply {
  status: number;
  body: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function readStores(supabase: SupabaseClient, tenantId: string): Promise<Reply> {
  const [{ data, error }, settings] = await Promise.all([
    supabase.from("stores").select("id, name, city, state").eq("tenant_id", tenantId).order("name"),
    psStores(supabase),
  ]);
  if (error) return { status: 500, body: { error: `Failed to read stores: ${error.message}` } };
  const now = new Date();
  return {
    status: 200,
    body: {
      time_zones: STORE_TIME_ZONES,
      stores: ((data ?? []) as { id: string; name: string; city: string | null; state: string | null }[]).map((s) => {
        const zone = settings.get(s.id)?.time_zone ?? DEFAULT_TIME_ZONE;
        return {
          id: s.id,
          name: s.name,
          place: [s.city, s.state].filter((v) => v && v.trim() !== "").join(", ") || null,
          time_zone: zone,
          // What day it is there now, so the page can show the zone is right.
          today: storeToday(zone, now),
        };
      }),
    },
  };
}

export async function writeStores(supabase: SupabaseClient, tenantId: string, body: Record<string, unknown>): Promise<Reply> {
  if (typeof body.store_id !== "string" || !UUID.test(body.store_id)) {
    return { status: 400, body: { error: "Which store is missing." } };
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
