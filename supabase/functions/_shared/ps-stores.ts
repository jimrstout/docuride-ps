// _shared/ps-stores.ts: PS's own settings per store (fni.ps_stores, migration 0059).
//
//   uses_ps    DocuRide PS is turned on for the store: sessions can start
//              there, and it is offered on Sessions and Staff. Sessions
//              already started are not affected.
//   time_zone  when the store's day ends: session expiry at 11:59 PM there,
//              and the sale-day checks (_shared/store-day.ts).
//
// Both are set on Administration > Stores. PS never reads or writes
// public.stores.time_zone any more; that column is left as it was.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface PsStore {
  store_id: string;
  uses_ps: boolean;
  time_zone: string;
}

/** Said when a deal's store does not use PS, word for word. */
export const PS_NOT_ON = "DocuRide PS isn't turned on for this store.";

/** The store's time zone, from fni.ps_stores; null when it has no row (the caller's default applies). */
export async function storeTimeZone(supabase: SupabaseClient, storeId: unknown): Promise<string | null> {
  if (typeof storeId !== "string") return null;
  const { data } = await supabase.schema("fni").from("ps_stores").select("time_zone").eq("store_id", storeId).maybeSingle();
  return (data as { time_zone?: string } | null)?.time_zone ?? null;
}

/** Whether DocuRide PS is turned on for the store. No row is off. */
export async function usesPs(supabase: SupabaseClient, storeId: unknown): Promise<boolean> {
  if (typeof storeId !== "string") return false;
  const { data, error } = await supabase.schema("fni").from("ps_stores").select("uses_ps").eq("store_id", storeId).maybeSingle();
  if (error) throw new Error(`fni.ps_stores: ${error.message}`);
  return (data as { uses_ps?: boolean } | null)?.uses_ps === true;
}

/** Every store's PS settings, by store id. */
export async function psStores(supabase: SupabaseClient): Promise<Map<string, PsStore>> {
  const { data, error } = await supabase.schema("fni").from("ps_stores").select("store_id, uses_ps, time_zone");
  if (error) throw new Error(`fni.ps_stores: ${error.message}`);
  return new Map(((data ?? []) as PsStore[]).map((r) => [r.store_id, r]));
}
