/*
 * Supabase REST helpers.
 *
 * Two distinct credentials, and the distinction matters (CLAUDE.md):
 *   - service role: server-side only, bypasses RLS. Used for all writes.
 *   - anon key + user JWT: used only to verify who a caller is.
 *
 * PostgREST is called directly rather than through supabase-js: the functions
 * here are short-lived and only need a handful of verbs, matching how
 * api/reports/reyrey.ts already talks to Supabase.
 */

const ENV = {
  url: process.env.SUPABASE_URL!,
  anonKey: process.env.SUPABASE_ANON_KEY!,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
};

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: ENV.serviceKey,
    Authorization: `Bearer ${ENV.serviceKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function rest<T>(path: string, init: RequestInit, what: string): Promise<T> {
  const r = await fetch(`${ENV.url}/rest/v1/${path}`, init);
  if (!r.ok) throw new Error(`Supabase ${what} ${r.status}: ${await r.text()}`);
  if (r.status === 204) return [] as unknown as T;
  const body = await r.text();
  return (body ? JSON.parse(body) : []) as T;
}

// ---------- reads ----------

/** GET with a raw PostgREST query string, e.g. "deals?zoho_id=eq.123&select=*". */
export async function sbSelect<T>(query: string): Promise<T[]> {
  return rest<T[]>(query, { headers: serviceHeaders() }, `select ${query}`);
}

// ---------- writes ----------

export async function sbInsert<T>(
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
  returning: "representation" | "minimal" = "minimal",
): Promise<T[]> {
  return rest<T[]>(
    table,
    {
      method: "POST",
      headers: serviceHeaders({ Prefer: `return=${returning}` }),
      body: JSON.stringify(rows),
    },
    `insert ${table}`,
  );
}

/**
 * Insert-or-update on a unique column. `onConflict` must name a column with a
 * unique constraint — deals.zoho_id for the mirror.
 */
export async function sbUpsert<T>(
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
  onConflict: string,
  returning: "representation" | "minimal" = "minimal",
): Promise<T[]> {
  return rest<T[]>(
    `${table}?on_conflict=${encodeURIComponent(onConflict)}`,
    {
      method: "POST",
      headers: serviceHeaders({
        Prefer: `resolution=merge-duplicates,return=${returning}`,
      }),
      body: JSON.stringify(rows),
    },
    `upsert ${table}`,
  );
}

/** PATCH rows matching a raw PostgREST filter, e.g. "id=eq.<uuid>". */
export async function sbUpdate<T>(
  table: string,
  filter: string,
  patch: Record<string, unknown>,
  returning: "representation" | "minimal" = "minimal",
): Promise<T[]> {
  return rest<T[]>(
    `${table}?${filter}`,
    {
      method: "PATCH",
      headers: serviceHeaders({ Prefer: `return=${returning}` }),
      body: JSON.stringify(patch),
    },
    `update ${table}`,
  );
}

// ---------- auth ----------

export interface AuthedUser {
  id: string;
  email: string;
  /** Null for a platform operator, who belongs to no single tenant. */
  tenantId: string | null;
  role: string;
  isPlatformAdmin: boolean;
}

/**
 * Resolve a caller's Supabase user from an Authorization header and join it to
 * their profile. Returns null for anything unauthenticated or profile-less —
 * a user without a profiles row has no tenant, so has access to nothing.
 */
export async function userFromRequest(authorization?: string): Promise<AuthedUser | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);

  const r = await fetch(`${ENV.url}/auth/v1/user`, {
    headers: { apikey: ENV.anonKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = (await r.json()) as { id?: string; email?: string };
  if (!user.id) return null;

  const profiles = await sbSelect<{
    tenant_id: string | null;
    role: string;
    is_platform_admin: boolean;
  }>(`profiles?user_id=eq.${user.id}&select=tenant_id,role,is_platform_admin`);
  const profile = profiles[0];
  if (!profile) return null;

  return {
    id: user.id,
    email: user.email ?? "",
    tenantId: profile.tenant_id,
    role: profile.role,
    isPlatformAdmin: profile.is_platform_admin,
  };
}

/** Constant-time-ish compare so a secret is not leaked by response timing. */
export function secretsMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the request carries `Authorization: Bearer CRON_SECRET`. */
export function isCronRequest(authorization?: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  return secretsMatch(authorization.slice(7), process.env.CRON_SECRET);
}

// ---------- tenant ----------

let cachedTenantId: string | null = null;

/**
 * The Zoho-synced tenant. Phase 1 is single-tenant (MIGRATION_PATH.md §4:
 * "All Seasons is tenant #1 throughout"), and the Zoho webhook carries no
 * tenant of its own, so the tenant is resolved from crm_sync = 'zoho'.
 *
 * Throws rather than guessing if that is ever ambiguous — when tenant #2
 * arrives with crm_sync = 'zoho', this must become an explicit mapping
 * (per-tenant webhook secret or a store-to-tenant lookup).
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
