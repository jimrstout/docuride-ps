// fni-admin-settings/pricing.ts
//
// The admin area's Pricing section: read the rules for a scope, and save,
// delete or copy them.
//
// Input:
//   GET  ?section=pricing&scope=<store id | all>&cost=<n>&product=<code>
//   POST { section: "pricing", action: "save" | "delete" | "copy", updated_by, ... }
//
// Same function, same secret, same operator sign-in in front of it as the
// Wording section. Its own file only so index.ts stays readable.
//
// ── Changes apply right away ──────────────────────────────────────────────
// fni-session-get reads fni.pricing_rules on every load, so a save here moves
// the price of a deal being presented now. That is why every check that can
// refuse a save runs here, on the server, and why each save records who made it.
//
// The formula and resolveRule are not touched. The preview and the gap check
// call them from _shared/planner-pricing.ts, through _shared/pricing-admin.ts.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SAMPLE_COSTS,
  copyRefusal,
  gapSentence,
  parseRuleFields,
  previewPrices,
  pricingGaps,
  ruleSummary,
  storeStatus,
  validateRule,
  type StoredRule,
} from "../_shared/pricing-admin.ts";

const RULE_COLUMNS =
  "id, tenant_id, store_id, product_code, cost_floor, cost_ceiling, markup_percent, " +
  "markup_max_dollars, markup_min_dollars, round_to, active, updated_at, updated_by";

/** The answer to a pricing request: a status and a body. index.ts sends it. */
export interface PricingReply {
  status: number;
  body: unknown;
}

interface Store {
  id: string;
  name: string;
}

interface Product {
  code: string;
  name: string;
}

/** Numbers as numbers. PostgREST sends numeric as a number, but not always. */
function asRule(r: Record<string, unknown>): StoredRule {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    store_id: (r.store_id as string | null) ?? null,
    product_code: (r.product_code as string | null) ?? null,
    cost_floor: n(r.cost_floor)!,
    cost_ceiling: n(r.cost_ceiling)!,
    markup_percent: n(r.markup_percent)!,
    markup_max_dollars: n(r.markup_max_dollars),
    markup_min_dollars: n(r.markup_min_dollars) ?? 0,
    round_to: n(r.round_to) ?? 0,
    active: r.active === true,
    updated_at: (r.updated_at as string | null) ?? null,
    updated_by: (r.updated_by as string | null) ?? null,
  };
}

/**
 * Stores with an active TecAssured account, by name. The menu runs only at
 * these, so they are the only stores the page lists and the only ones a
 * store-specific rule can be saved for. Nothing here names a store.
 */
async function menuStores(supabase: SupabaseClient, tenantId: string): Promise<Store[]> {
  const { data: accounts, error } = await supabase
    .schema("fni")
    .from("store_provider_accounts")
    .select("store_id")
    .eq("provider", "TecAssured")
    .eq("active", true);
  if (error) throw new Error(`Failed to read store accounts: ${error.message}`);

  const ids = [...new Set((accounts ?? []).map((a) => String((a as { store_id: string }).store_id)))];
  if (ids.length === 0) return [];

  const { data: stores, error: storeError } = await supabase
    .from("stores")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .in("id", ids);
  if (storeError) throw new Error(`Failed to read stores: ${storeError.message}`);

  return ((stores ?? []) as Store[]).sort((a, b) => a.name.localeCompare(b.name));
}

async function tenantRules(supabase: SupabaseClient, tenantId: string): Promise<StoredRule[]> {
  const { data, error } = await supabase
    .schema("fni")
    .from("pricing_rules")
    .select(RULE_COLUMNS)
    .eq("tenant_id", tenantId);
  if (error) throw new Error(`Failed to read pricing rules: ${error.message}`);
  // The column list is built from a constant, so supabase-js cannot infer the
  // row type from it; asRule reads each field explicitly instead.
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(asRule);
}

/**
 * The products a rule can name in a scope, by display name: the tenant's
 * catalog, plus the store's own rows for a store. A store row's name wins over
 * the tenant's for the same code, the way the planner reads the catalog. Two
 * products with one name are told apart by their code.
 */
async function scopeProducts(
  supabase: SupabaseClient,
  tenantId: string,
  storeId: string | null
): Promise<Product[]> {
  let q = supabase
    .schema("fni")
    .from("product_catalog")
    .select("store_id, product_code, display_name, display_order")
    .eq("tenant_id", tenantId);
  q = storeId === null ? q.is("store_id", null) : q.or(`store_id.eq.${storeId},store_id.is.null`);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to read the product catalog: ${error.message}`);

  const rows = (data ?? []) as { store_id: string | null; product_code: string; display_name: string | null; display_order: number | null }[];
  const byCode = new Map<string, { name: string; order: number }>();
  for (const r of rows.filter((r) => r.store_id === null)) {
    byCode.set(r.product_code, { name: r.display_name ?? r.product_code, order: r.display_order ?? 0 });
  }
  for (const r of rows.filter((r) => r.store_id !== null)) {
    byCode.set(r.product_code, { name: r.display_name ?? r.product_code, order: r.display_order ?? 0 });
  }

  const list = [...byCode.entries()].map(([code, v]) => ({ code, ...v }));
  const counts = new Map<string, number>();
  for (const p of list) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);

  return list
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((p) => ({ code: p.code, name: (counts.get(p.name) ?? 0) > 1 ? `${p.name} (${p.code})` : p.name }));
}

/** "all" is All stores; anything else must be a menu store's id. */
function readScope(raw: unknown, stores: Store[]): { storeId: string | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "" || raw === "all") return { storeId: null };
  const id = String(raw);
  if (!stores.some((s) => s.id === id)) {
    return { error: "That store does not have an active TecAssured account, so it cannot have its own pricing." };
  }
  return { storeId: id };
}

function amountParam(v: string | null): number | null {
  if (v === null) return null;
  const s = v.replace(/[$,\s]/g, "");
  if (s === "" || !/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n <= 1_000_000 ? Math.round(n * 100) / 100 : null;
}

export async function readPricing(
  supabase: SupabaseClient,
  tenantId: string,
  params: URLSearchParams
): Promise<PricingReply> {
  const stores = await menuStores(supabase, tenantId);
  const scope = readScope(params.get("scope"), stores);
  if ("error" in scope) return { status: 400, body: { error: scope.error } };
  const storeId = scope.storeId;

  const [rules, products] = await Promise.all([
    tenantRules(supabase, tenantId),
    scopeProducts(supabase, tenantId, storeId),
  ]);
  const nameOf = (code: string | null) =>
    code === null ? null : (products.find((p) => p.code === code)?.name ?? code);

  const own = rules
    .filter((r) => r.store_id === storeId)
    .sort((a, b) =>
      (a.product_code ?? "").localeCompare(b.product_code ?? "") || a.cost_floor - b.cost_floor
    );

  // The product the preview prices as. Blank is All products.
  const productParam = params.get("product");
  const previewProduct =
    productParam && products.some((p) => p.code === productParam) ? productParam : null;
  const typedCost = amountParam(params.get("cost"));

  return {
    status: 200,
    body: {
      stores: stores.map((s) => ({ ...s, status: storeStatus(rules, s.id) })),
      all_stores_active_rules: rules.filter((r) => r.active && r.store_id === null).length,
      scope: {
        store_id: storeId,
        name: storeId === null ? "All stores" : stores.find((s) => s.id === storeId)!.name,
      },
      products,
      rules: own.map((r) => ({
        ...r,
        product_name: nameOf(r.product_code),
        summary: ruleSummary(r, nameOf(r.product_code)),
      })),
      preview: {
        product_code: previewProduct,
        rows: previewPrices(rules, storeId, SAMPLE_COSTS, previewProduct, nameOf),
        typed: typedCost === null ? null : previewPrices(rules, storeId, [typedCost], previewProduct, nameOf)[0],
      },
      gaps: pricingGaps(rules, storeId).map((g) => ({ ...g, sentence: gapSentence(g) })),
      // Where copying can go: All stores, and each menu store, other than here.
      copy_targets: [
        ...(storeId === null ? [] : [{ store_id: null, name: "All stores", has_rules: rules.some((r) => r.store_id === null) }]),
        ...stores
          .filter((s) => s.id !== storeId)
          .map((s) => ({ store_id: s.id, name: s.name, has_rules: rules.some((r) => r.store_id === s.id) })),
      ],
    },
  };
}

function refused(errors: string[]): PricingReply {
  return { status: 400, body: { error: errors.join(" "), errors } };
}

export async function writePricing(
  supabase: SupabaseClient,
  tenantId: string,
  body: Record<string, unknown>
): Promise<PricingReply> {
  // Every save carries the operator's email, so the rule can say who changed it.
  const updatedBy = typeof body.updated_by === "string" ? body.updated_by.trim() : "";
  if (updatedBy === "" || updatedBy.length > 320) {
    return refused(["A change to pricing needs the name of whoever is signed in."]);
  }

  const stores = await menuStores(supabase, tenantId);
  const activeStoreIds = new Set(stores.map((s) => s.id));
  const scope = readScope(body.scope, stores);
  if ("error" in scope) return refused([scope.error]);
  const storeId = scope.storeId;

  const rules = await tenantRules(supabase, tenantId);
  const now = new Date().toISOString();
  const action = body.action;

  if (action === "save") {
    const parsed = parseRuleFields((body.rule ?? {}) as Record<string, unknown>);
    if ("errors" in parsed) return refused(parsed.errors);
    const fields = parsed.fields;

    const products = await scopeProducts(supabase, tenantId, storeId);
    if (fields.product_code !== null && !products.some((p) => p.code === fields.product_code)) {
      return refused(["That product is not in the catalog here."]);
    }

    const ruleId = typeof body.rule_id === "string" && body.rule_id !== "" ? body.rule_id : null;
    if (ruleId !== null) {
      const existing = rules.find((r) => r.id === ruleId);
      // A rule stays in the scope it was made in. Moving it is a copy and a delete.
      if (!existing || existing.store_id !== storeId) {
        return refused(["That rule is no longer here. Reload the page and try again."]);
      }
    }

    const nameOf = (code: string | null) =>
      code === null ? "all products" : (products.find((p) => p.code === code)?.name ?? code);
    const errors = validateRule(fields, storeId, rules, ruleId, activeStoreIds, { product: nameOf });
    if (errors.length > 0) return refused(errors);

    const row = { ...fields, updated_at: now, updated_by: updatedBy };
    const { error } = ruleId === null
      ? await supabase.schema("fni").from("pricing_rules")
          .insert({ ...row, tenant_id: tenantId, store_id: storeId })
      : await supabase.schema("fni").from("pricing_rules")
          .update(row).eq("id", ruleId).eq("tenant_id", tenantId);
    if (error) return { status: 500, body: { error: `Failed to save the rule: ${error.message}` } };
    return { status: 200, body: { ok: true } };
  }

  if (action === "delete") {
    const ruleId = typeof body.rule_id === "string" ? body.rule_id : "";
    const existing = rules.find((r) => r.id === ruleId);
    if (!existing || existing.store_id !== storeId) {
      return refused(["That rule is no longer here. Reload the page and try again."]);
    }
    const { error } = await supabase.schema("fni").from("pricing_rules")
      .delete().eq("id", ruleId).eq("tenant_id", tenantId);
    if (error) return { status: 500, body: { error: `Failed to delete the rule: ${error.message}` } };
    return { status: 200, body: { ok: true } };
  }

  if (action === "copy") {
    const to = readScope(body.to_scope, stores);
    if ("error" in to) return refused([to.error]);
    const why = copyRefusal(storeId, to.storeId, rules, activeStoreIds);
    if (why !== null) return refused([why]);

    const copies = rules
      .filter((r) => r.store_id === storeId)
      .map((r) => ({
        tenant_id: tenantId,
        store_id: to.storeId,
        product_code: r.product_code,
        cost_floor: r.cost_floor,
        cost_ceiling: r.cost_ceiling,
        markup_percent: r.markup_percent,
        markup_max_dollars: r.markup_max_dollars,
        markup_min_dollars: r.markup_min_dollars,
        round_to: r.round_to,
        active: r.active,
        updated_at: now,
        updated_by: updatedBy,
      }));
    // One insert, so a copy lands whole or not at all.
    const { error } = await supabase.schema("fni").from("pricing_rules").insert(copies);
    if (error) return { status: 500, body: { error: `Failed to copy the rules: ${error.message}` } };
    return { status: 200, body: { ok: true, copied: copies.length } };
  }

  return refused(["That is not something the Pricing page can do."]);
}
