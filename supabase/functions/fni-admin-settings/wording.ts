// fni-admin-settings/wording.ts: Providers, Product wording.
//
// GET  ?section=wording&provider_id=   the provider's catalog products, with
//                                      their wording and what each still needs
// POST { section: "wording", action: "save", product_id, display_name, goal,
//        what_it_accomplishes, ..., transferable, active, updated_by }
//
// A product an OEM sheet adds to the catalog has a name and a category and no
// wording, so the planner does not show it. Staff write the wording here. It
// is never generated. The tenant-wide row is edited; a store's own copy of a
// product, where one exists, is left as it is.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseWording, wordingMissing } from "../_shared/menu-admin.ts";
import type { Reply } from "./providers.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const COLUMNS =
  "id, provider_id, product_code, display_name, category, goal, what_it_accomplishes, what_it_covers, " +
  "coverage_duration, what_it_excludes, deductible_note, how_to_use, transferable, transfer_note, " +
  "future_value_note, full_terms_url, active, updated_at";

export async function readWording(supabase: SupabaseClient, tenantId: string, providerId: string): Promise<Reply> {
  if (!UUID.test(providerId)) return { status: 400, body: { error: "Which provider is missing." } };
  const { data, error } = await supabase
    .schema("fni")
    .from("product_catalog")
    .select(COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("provider_id", providerId)
    .is("store_id", null)
    .order("category")
    .order("display_name");
  if (error) throw new Error(`Failed to read the products: ${error.message}`);
  return {
    status: 200,
    body: {
      products: ((data ?? []) as unknown as Record<string, unknown>[]).map((p) => ({ ...p, missing: wordingMissing(p) })),
    },
  };
}

export async function writeWording(
  supabase: SupabaseClient,
  tenantId: string,
  body: Record<string, unknown>
): Promise<Reply> {
  const by = typeof body.updated_by === "string" ? body.updated_by.trim() : "";
  if (by === "") return { status: 400, body: { error: "Who is making the change is missing." } };
  if (body.action !== "save") return { status: 400, body: { error: "Unknown action." } };
  if (typeof body.product_id !== "string" || !UUID.test(body.product_id)) {
    return { status: 400, body: { error: "Which product is missing." } };
  }
  const parsed = parseWording(body);
  if ("errors" in parsed) return { status: 400, body: { error: parsed.errors.join(" ") } };
  const { data, error } = await supabase
    .schema("fni")
    .from("product_catalog")
    .update({ ...parsed.fields, updated_at: new Date().toISOString() })
    .eq("id", body.product_id)
    .eq("tenant_id", tenantId)
    .is("store_id", null)
    .select("id")
    .maybeSingle();
  if (error) return { status: 500, body: { error: error.message } };
  if (!data) return { status: 404, body: { error: "That product is not in the catalog." } };
  return { status: 200, body: { ok: true } };
}
