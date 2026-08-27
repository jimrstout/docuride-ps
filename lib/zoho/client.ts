/*
 * Zoho CRM v8 API client.
 *
 * Token refresh is cached in module scope. Vercel keeps a warm function
 * instance alive across invocations, so the cron worker firing every minute
 * reuses one access token for its full hour rather than burning a refresh
 * call per run (Zoho caps refreshes per 10 minutes).
 */

const ENV = {
  clientId: process.env.ZOHO_CLIENT_ID!,
  clientSecret: process.env.ZOHO_CLIENT_SECRET!,
  refreshToken: process.env.ZOHO_REFRESH_TOKEN!,
  accounts: process.env.ZOHO_ACCOUNTS_DOMAIN ?? "https://accounts.zoho.com",
  api: process.env.ZOHO_API_DOMAIN ?? "https://www.zohoapis.com",
};

// Zoho access tokens live one hour. Refresh a minute early to avoid racing
// expiry mid-request.
const TOKEN_SKEW_MS = 60_000;

export type ZohoRecord = Record<string, unknown> & { id: string };

interface CachedToken { token: string; expiresAt: number }
let cached: CachedToken | null = null;
let inFlight: Promise<string> | null = null;

// ---------- auth ----------

async function refresh(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ENV.clientId,
    client_secret: ENV.clientSecret,
    refresh_token: ENV.refreshToken,
  });
  const r = await fetch(`${ENV.accounts}/oauth/v2/token`, { method: "POST", body });
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!j.access_token) throw new Error(`Zoho token error: ${j.error ?? "unknown"}`);
  cached = {
    token: j.access_token,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 - TOKEN_SKEW_MS,
  };
  return j.access_token;
}

export async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  // Collapse concurrent refreshes so a burst of queue items triggers one call.
  if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
  return inFlight;
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  return fetch(`${ENV.api}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Zoho-oauthtoken ${token}`,
    },
  });
}

// ---------- records ----------

/** Fetch one record. Returns null when Zoho has no such id (deleted record). */
export async function getRecord(module: string, id: string): Promise<ZohoRecord | null> {
  const r = await authed(`/crm/v8/${module}/${encodeURIComponent(id)}`);
  if (r.status === 204 || r.status === 404) return null;
  if (!r.ok) throw new Error(`Zoho getRecord ${module}/${id} ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { data?: ZohoRecord[] };
  return j.data?.[0] ?? null;
}

export interface ZohoWriteResult {
  code: string;
  status: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Update a single record. `fields` is a partial map of Zoho API field names
 * to values — case-sensitive, verify against getFields before use.
 * Throws unless Zoho reports SUCCESS, so callers log a real error rather
 * than a silently-ignored write.
 */
export async function updateRecord(
  module: string,
  id: string,
  fields: Record<string, unknown>,
): Promise<ZohoWriteResult> {
  const r = await authed(`/crm/v8/${module}/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [fields] }),
  });
  if (!r.ok) throw new Error(`Zoho updateRecord ${module}/${id} ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { data?: ZohoWriteResult[] };
  const result = j.data?.[0];
  if (!result) throw new Error(`Zoho updateRecord ${module}/${id}: empty response`);
  if (result.status !== "success") {
    throw new Error(`Zoho updateRecord ${module}/${id}: ${result.code} ${result.message}`);
  }
  return result;
}

// ---------- coql ----------

/**
 * Run a COQL query, following pagination to exhaustion.
 *
 * The caller supplies everything up to (not including) LIMIT/OFFSET; this
 * appends them. Note CLAUDE.md: COQL allows at most two conditions per
 * parenthesis level, so nest WHERE clauses pairwise.
 *
 * Zoho refuses OFFSET beyond 100,000 rows. `maxRows` stops cleanly before
 * that rather than letting the API error out mid-backfill.
 */
export async function coqlAll<T>(selectQuery: string, maxRows = 100_000): Promise<T[]> {
  const out: T[] = [];
  const pageSize = 200;
  let offset = 0;
  for (;;) {
    const r = await authed(`/crm/v8/coql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select_query: `${selectQuery} LIMIT ${pageSize} OFFSET ${offset}` }),
    });
    if (r.status === 204) break;
    if (!r.ok) throw new Error(`Zoho COQL ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as { data: T[]; info: { more_records: boolean } };
    out.push(...j.data);
    if (!j.info.more_records) break;
    offset += pageSize;
    if (offset >= maxRows) break;
  }
  return out;
}
