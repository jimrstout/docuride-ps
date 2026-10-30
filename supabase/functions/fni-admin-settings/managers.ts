// fni-admin-settings/managers.ts: who may change presets and price bands, and
// the record of every change (migration 0045).
//
// A manager is a signed-in operator whose profile role is owner or admin
// (fni.is_menu_manager). Other signed-in staff see presets and bands but
// cannot change them. Every change is a row in fni.admin_change_log: what,
// before, after, who and when. A failure to log fails the save, so no change
// goes unrecorded.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MANAGERS_ONLY = "Only a manager can change this. Ask a manager to sign in and make the change.";

/** Whether the signed-in operator is a manager. Unknown or missing: no. */
export async function isManager(supabase: SupabaseClient, operatorId: unknown): Promise<boolean> {
  if (typeof operatorId !== "string" || !UUID.test(operatorId)) return false;
  const { data, error } = await supabase.schema("fni").rpc("is_menu_manager", { p_user: operatorId });
  if (error) {
    console.error("fni-admin-settings manager check failed", { code: error.code ?? null });
    return false;
  }
  return data === true;
}

export interface Change {
  area: "Menu preset" | "Price band";
  record_key: string;
  action: "Created" | "Changed" | "Removed";
  before: unknown;
  after: unknown;
}

/** Record changes. Throws when they cannot be recorded. */
export async function logChanges(supabase: SupabaseClient, tenantId: string, by: string, changes: Change[]): Promise<void> {
  if (changes.length === 0) return;
  const { error } = await supabase
    .schema("fni")
    .from("admin_change_log")
    .insert(changes.map((c) => ({ ...c, tenant_id: tenantId, changed_by: by })));
  if (error) throw new Error(`The change could not be recorded, so it was not saved (${error.code ?? "error"}).`);
}

/** The latest changes in an area, newest first, for the page. */
export async function recentChanges(supabase: SupabaseClient, tenantId: string, area: Change["area"], limit = 15) {
  const { data } = await supabase
    .schema("fni")
    .from("admin_change_log")
    .select("record_key, action, before, after, changed_by, changed_at")
    .eq("tenant_id", tenantId)
    .eq("area", area)
    .order("changed_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as { record_key: string; action: string; before: unknown; after: unknown; changed_by: string; changed_at: string }[];
}
