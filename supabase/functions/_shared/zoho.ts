/*
 * Zoho CRM v8 API client (Deno).
 *
 * Credentials are Edge Function secrets per ARCHITECTURE.md's secrets table.
 * fetch is identical to the Node version; only env access changes.
 *
 * KNOWN LIMITATION — the access token is cached in module scope, so it is
 * shared only within one warm isolate. Every cold start performs its own
 * refresh. On Vercel at one-minute cadence that was enough to make Zoho answer
 * "Access Denied" to the token endpoint. The 5-minute sweeper gives this far
 * more headroom, but a burst of webhooks can still stack refreshes. The real
 * fix is a shared token row in Postgres that every isolate reads; see the note
 * in TICKET-002's handover.
 */

const ENV = {
  clientId: Deno.env.get("ZOHO_CLIENT_ID")!,
  clientSecret: Deno.env.get("ZOHO_CLIENT_SECRET")!,
  refreshToken: Deno.env.get("ZOHO_REFRESH_TOKEN")!,
  accounts: Deno.env.get("ZOHO_ACCOUNTS_DOMAIN") ?? "https://accounts.zoho.com",
  api: Deno.env.get("ZOHO_API_DOMAIN") ?? "https://www.zohoapis.com",
};

// Zoho access tokens live one hour; refresh a minute early to avoid racing expiry.
const TOKEN_SKEW_MS = 60_000;

export type ZohoRecord = Record<string, unknown> & { id: string };

let cached: { token: string; expiresAt: number } | null = null;
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
  if (!j.access_token) {
    // Lengths only, never values — tells an unset credential apart from a
    // wrong one without putting anything sensitive in the log.
    console.error("zoho token refresh rejected", {
      error: j.error ?? "unknown",
      clientIdLength: ENV.clientId?.length ?? 0,
      clientSecretLength: ENV.clientSecret?.length ?? 0,
      refreshTokenLength: ENV.refreshToken?.length ?? 0,
      accounts: ENV.accounts,
    });
    throw new Error(`Zoho token error: ${j.error ?? "unknown"}`);
  }
  cached = {
    token: j.access_token,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 - TOKEN_SKEW_MS,
  };
  return j.access_token;
}

export function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.token);
  // Collapse concurrent refreshes so a batch of queue items costs one call.
  if (!inFlight) {
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  }
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

/** Fetch one record. Null when Zoho has no such id — a deleted record. */
export async function getRecord(module: string, id: string): Promise<ZohoRecord | null> {
  const r = await authed(`/crm/v8/${module}/${encodeURIComponent(id)}`);
  if (r.status === 204 || r.status === 404) return null;
  if (!r.ok) throw new Error(`Zoho getRecord ${module}/${id} ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { data?: ZohoRecord[] };
  return j.data?.[0] ?? null;
}

// ---------- coql ----------

/**
 * Run a COQL query, following pagination to exhaustion. The caller supplies
 * everything up to LIMIT/OFFSET; this appends them.
 *
 * Note CLAUDE.md: COQL allows at most two conditions per parenthesis level, so
 * nest WHERE clauses pairwise. Zoho refuses OFFSET beyond 100,000 rows, so
 * maxRows stops cleanly rather than erroring mid-backfill.
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
