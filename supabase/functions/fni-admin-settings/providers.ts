// fni-admin-settings/providers.ts: the admin area's Providers section.
//
// GET  ?section=providers   every provider, the stores each is sold at, and its
//                           price sheets in brief
// POST { section: "providers", action: "save", provider_id, name, makes, active, notes, updated_by }
// POST { section: "providers", action: "add", name, makes, notes, updated_by }
// POST { section: "providers", action: "stores", provider_id, store_ids, updated_by }
//
// A provider added here is a Price Sheet provider whose contracts are recorded
// by staff: a Connected provider needs an adapter, which is code. Which stores
// sell a Price Sheet provider's program is set here; a Connected provider's
// accounts carry a login and a Dealer ID and are shown, not edited. Migration
// 0026 checks every store account against its provider either way.
//
// Nothing is deleted: a provider is switched off, a store's account is made
// inactive.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseProvider, parseStoreIds } from "../_shared/menu-admin.ts";

export interface Reply {
  status: number;
  body: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function stores(supabase: SupabaseClient, tenantId: string) {
  const { data, error } = await supabase.from("stores").select("id, name").eq("tenant_id", tenantId).order("name");
  if (error) throw new Error(`Failed to read stores: ${error.message}`);
  return (data ?? []) as { id: string; name: string }[];
}

export async function readProviders(supabase: SupabaseClient, tenantId: string): Promise<Reply> {
  const [{ data: providers, error }, storeRows] = await Promise.all([
    supabase
      .schema("fni")
      .from("providers")
      .select("id, name, kind, adapter, contract_method, makes, active, notes, updated_at, updated_by")
      .eq("tenant_id", tenantId)
      .order("name"),
    stores(supabase, tenantId),
  ]);
  if (error) throw new Error(`Failed to read providers: ${error.message}`);
  const ids = ((providers ?? []) as { id: string }[]).map((p) => p.id);

  const [{ data: accounts }, { data: sheets }] = await Promise.all([
    supabase
      .schema("fni")
      .from("store_provider_accounts")
      .select("provider_id, store_id, dealer_code, active")
      .in("provider_id", ids),
    supabase
      .schema("fni")
      .from("price_sheets")
      .select("provider_id, name, status, parse_status, effective_from, effective_to")
      .in("provider_id", ids),
  ]);

  const storeName = new Map(storeRows.map((s) => [s.id, s.name]));
  return {
    status: 200,
    body: {
      stores: storeRows,
      providers: ((providers ?? []) as Record<string, unknown>[]).map((p) => ({
        ...p,
        stores: ((accounts ?? []) as { provider_id: string; store_id: string; dealer_code: string | null; active: boolean }[])
          .filter((a) => a.provider_id === p.id)
          .map((a) => ({
            store_id: a.store_id,
            name: storeName.get(a.store_id) ?? "A store",
            dealer_code: a.dealer_code,
            active: a.active,
          })),
        sheets: ((sheets ?? []) as { provider_id: string; name: string; status: string }[])
          .filter((s) => s.provider_id === p.id)
          .map((s) => ({ name: s.name, status: s.status })),
      })),
    },
  };
}

export async function writeProviders(
  supabase: SupabaseClient,
  tenantId: string,
  body: Record<string, unknown>
): Promise<Reply> {
  const by = typeof body.updated_by === "string" ? body.updated_by.trim() : "";
  if (by === "") return { status: 400, body: { error: "Who is making the change is missing." } };
  const now = new Date().toISOString();

  if (body.action === "add" || body.action === "save") {
    const parsed = parseProvider(body);
    if ("errors" in parsed) return { status: 400, body: { error: parsed.errors.join(" ") } };
    const f = parsed.fields;

    if (body.action === "add") {
      const { error } = await supabase.schema("fni").from("providers").insert({
        tenant_id: tenantId,
        name: f.name,
        kind: "Price Sheet",
        adapter: null,
        contract_method: "Recorded by Staff",
        makes: f.makes,
        notes: f.notes,
        active: true,
        updated_by: by,
      });
      if (error) {
        return error.code === "23505"
          ? { status: 400, body: { error: `There is already a provider called ${f.name}.` } }
          : { status: 500, body: { error: error.message } };
      }
      return { status: 200, body: { ok: true } };
    }

    if (typeof body.provider_id !== "string" || !UUID.test(body.provider_id)) {
      return { status: 400, body: { error: "Which provider is missing." } };
    }
    const { error } = await supabase
      .schema("fni")
      .from("providers")
      .update({ name: f.name, makes: f.makes, active: f.active, notes: f.notes, updated_by: by, updated_at: now })
      .eq("id", body.provider_id)
      .eq("tenant_id", tenantId);
    if (error) {
      return error.code === "23505"
        ? { status: 400, body: { error: `There is already a provider called ${f.name}.` } }
        : { status: 500, body: { error: error.message } };
    }
    return { status: 200, body: { ok: true } };
  }

  if (body.action === "stores") {
    if (typeof body.provider_id !== "string" || !UUID.test(body.provider_id)) {
      return { status: 400, body: { error: "Which provider is missing." } };
    }
    const { data: provider } = await supabase
      .schema("fni")
      .from("providers")
      .select("id, name, kind")
      .eq("id", body.provider_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const p = provider as { id: string; name: string; kind: string } | null;
    if (!p) return { status: 404, body: { error: "That provider does not exist." } };
    if (p.kind !== "Price Sheet") {
      return {
        status: 400,
        body: { error: `${p.name}'s store accounts carry a login and a Dealer ID, so they are set up by DocuRide staff.` },
      };
    }

    const all = await stores(supabase, tenantId);
    const parsed = parseStoreIds(body.store_ids, all.map((s) => s.id));
    if ("errors" in parsed) return { status: 400, body: { error: parsed.errors.join(" ") } };
    const wanted = new Set(parsed.ids);

    const { data: existing } = await supabase
      .schema("fni")
      .from("store_provider_accounts")
      .select("id, store_id, active")
      .eq("provider_id", p.id);
    const have = (existing ?? []) as { id: string; store_id: string; active: boolean }[];

    for (const a of have) {
      const on = wanted.has(a.store_id);
      if (a.active !== on) {
        const { error } = await supabase.schema("fni").from("store_provider_accounts").update({ active: on }).eq("id", a.id);
        if (error) return { status: 400, body: { error: error.message } };
      }
    }
    for (const storeId of wanted) {
      if (have.some((a) => a.store_id === storeId)) continue;
      const { error } = await supabase.schema("fni").from("store_provider_accounts").insert({
        store_id: storeId,
        provider_id: p.id,
        credential_id: null,
        dealer_code: null,
        active: true,
      });
      if (error) return { status: 400, body: { error: error.message } };
    }
    return { status: 200, body: { ok: true } };
  }

  return { status: 400, body: { error: "Unknown action." } };
}
