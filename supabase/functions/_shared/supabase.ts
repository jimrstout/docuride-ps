/*
 * Supabase REST helpers for Edge Functions.
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected into every Edge
 * Function by the platform (ARCHITECTURE.md: "Edge Functions have it
 * natively"), so neither is a secret we set. The service role bypasses RLS,
 * which is what lets the sweeper read sync_queue — that table has RLS enabled
 * with no policies, so it is invisible to anon and authenticated alike.
 *
 * PostgREST is called directly rather than through supabase-js: these
 * functions need four verbs and no session handling, and one less dependency
 * is one less cold-start import.
 */

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function rest<T>(path: string, init: RequestInit, what: string): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/${path}`, init);
  if (!r.ok) throw new Error(`Supabase ${what} ${r.status}: ${await r.text()}`);
  if (r.status === 204) return [] as unknown as T;
  const body = await r.text();
  return (body ? JSON.parse(body) : []) as T;
}

/** GET with a raw PostgREST query, e.g. "deals?zoho_id=eq.123&select=*". */
export function sbSelect<T>(query: string): Promise<T[]> {
  return rest<T[]>(query, { headers: headers() }, `select ${query}`);
}

export function sbInsert(
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<unknown[]> {
  return rest(
    table,
    { method: "POST", headers: headers({ Prefer: "return=minimal" }), body: JSON.stringify(rows) },
    `insert ${table}`,
  );
}

/** Insert-or-update on a column carrying a unique constraint. */
export function sbUpsert(
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
  onConflict: string,
): Promise<unknown[]> {
  return rest(
    `${table}?on_conflict=${encodeURIComponent(onConflict)}`,
    {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(rows),
    },
    `upsert ${table}`,
  );
}

/** PATCH rows matching a raw PostgREST filter, e.g. "id=eq.7". */
export function sbUpdate(
  table: string,
  filter: string,
  patch: Record<string, unknown>,
): Promise<unknown[]> {
  return rest(
    `${table}?${filter}`,
    { method: "PATCH", headers: headers({ Prefer: "return=minimal" }), body: JSON.stringify(patch) },
    `update ${table}`,
  );
}

// ---------- auth ----------

/** Length-independent compare, so a secret is not revealed by response timing. */
export function secretsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- tenant ----------

let cachedTenantId: string | null = null;

/**
 * The Zoho-synced tenant. Phase 1 is single-tenant (MIGRATION_PATH.md §4) and
 * the Zoho webhook carries no tenant of its own, so it is resolved from
 * crm_sync = 'zoho'. Throws rather than guessing if that is ambiguous — a
 * second Zoho tenant needs an explicit mapping, not a silent first-row pick.
 */
export async function zohoTenantId(): Promise<string> {
  if (cachedTenantId) return cachedTenantId;
  const rows = await sbSelect<{ id: string }>("tenants?crm_sync=eq.zoho&select=id");
  if (rows.length !== 1) {
    throw new Error(
      `Expected exactly one tenant with crm_sync='zoho', found ${rows.length}. ` +
        `Zoho sync needs an explicit tenant mapping before a second Zoho tenant is added.`,
    );
  }
  cachedTenantId = rows[0].id;
  return cachedTenantId;
}
