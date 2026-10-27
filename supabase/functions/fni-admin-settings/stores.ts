// fni-admin-settings/stores.ts: the admin area's Stores section.
//
// GET  ?section=stores   every store of the dealer group, with its time zone
// POST { section: "stores", store_id, time_zone, updated_by }
//
// A store's time zone decides when its day ends: a planning session lasts to
// 23:59:59 that day, and contracts can be submitted only when the sale date is
// that day (migration 0038, _shared/store-day.ts). Only the time zone is edited
// here; the rest of a store's details come from the CRM (dc-dealer-sync), which
// does not write this column.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DEFAULT_TIME_ZONE, isStoreTimeZone, STORE_TIME_ZONES, storeToday } from "../_shared/store-day.ts";

export interface Reply {
  status: number;
  body: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function readStores(supabase: SupabaseClient, tenantId: string): Promise<Reply> {
  const { data, error } = await supabase
    .from("stores")
    .select("id, name, city, state, time_zone")
    .eq("tenant_id", tenantId)
    .order("name");
  if (error) return { status: 500, body: { error: `Failed to read stores: ${error.message}` } };
  const now = new Date();
  return {
    status: 200,
    body: {
      time_zones: STORE_TIME_ZONES,
      stores: ((data ?? []) as { id: string; name: string; city: string | null; state: string | null; time_zone: string | null }[]).map(
        (s) => ({
          id: s.id,
          name: s.name,
          place: [s.city, s.state].filter((v) => v && v.trim() !== "").join(", ") || null,
          time_zone: s.time_zone ?? DEFAULT_TIME_ZONE,
          // What day it is there now, so the page can show the zone is right.
          today: storeToday(s.time_zone, now),
        })
      ),
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
  const { data, error } = await supabase
    .from("stores")
    .update({ time_zone: body.time_zone })
    .eq("id", body.store_id)
    .eq("tenant_id", tenantId)
    .select("id, name")
    .maybeSingle();
  if (error) return { status: 500, body: { error: error.message } };
  if (!data) return { status: 404, body: { error: "That store does not exist." } };
  console.log(`fni-admin-settings store ${body.store_id} time_zone = ${body.time_zone} by ${who || "(not given)"}`);
  return { status: 200, body: { ok: true } };
}
