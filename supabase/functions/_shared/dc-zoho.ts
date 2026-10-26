// _shared/dc-zoho.ts
//
// DocuRide DC's Zoho client, for the one thing PS does in WorkDrive: saving a
// provider's contract document into the deal's Deal Jacket, and renaming it
// when the contract is voided.
//
// ── Whose client ─────────────────────────────────────────────────────────
// PS's own Zoho client (_shared/zoho.ts, ZOHO_CLIENT_*) is for the CRM. The
// Document Center's client already has WorkDrive.files.ALL and is how DC's own
// documents reach the same Deal Jackets, so this uses it rather than asking
// for a new grant:
//   ZOHO_DC_CLIENT_ID, ZOHO_DC_CLIENT_SECRET, ZOHO_DC_REFRESH_TOKEN
// They are Supabase Edge Function secrets, project-wide, read here by name
// only. Nothing reads, logs or returns a token or a secret value.
//
// ── One token, shared with DC ────────────────────────────────────────────
// Zoho allows only about 10 new access tokens per refresh token every 10
// minutes, so this keeps DC's rules exactly, against DC's own row
// (dc.zoho_dc_token): use the shared token while it is good; otherwise one
// refresh at a time under the row lock, waiting up to 20 seconds for another
// instance's refresh; after a refused refresh, do not ask Zoho again for 30
// seconds. A copy of docuride-dc's _shared/dc-zoho.ts and dc-zoho-token.ts,
// reduced to the token and dcFetch; keep it in step with them.
//
// ── 401s ─────────────────────────────────────────────────────────────────
// Only a 401 that says the token itself is bad drops it and retries once. A
// 401 for a missing scope comes straight back, so the caller can say which.

import postgres from "npm:postgres@3.4.4";

/** Treat a token as expired this long before Zoho would. */
const TOKEN_SKEW_MS = 120_000;
/** How long a refused refresh stops other instances from asking Zoho. */
const FAILURE_HOLD_MS = 30_000;
/** How long an instance waits for another's refresh. */
const LOCK_WAIT = "20s";

/** The error code when Zoho will not give this client a token. */
export const ZOHO_SIGN_IN_FAILED = "Zoho Sign-In Failed";

interface DcToken {
  value: string;
  expiresAt: number;
}

const fresh = (t: DcToken | null, now = Date.now()): t is DcToken => !!t && now < t.expiresAt - TOKEN_SKEW_MS;

let sql: ReturnType<typeof postgres> | null = null;
function db() {
  sql ??= postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
  return sql;
}

let token: DcToken | null = null;
let inFlight: Promise<string> | null = null;

function signInError(zohoError: string): Error {
  return Object.assign(new Error(`Zoho DC token error: ${zohoError}`), { code: ZOHO_SIGN_IN_FAILED, zohoError });
}

function toToken(row: Record<string, unknown> | undefined): DcToken | null {
  if (!row?.access_token || !row.expires_at) return null;
  return { value: String(row.access_token), expiresAt: new Date(row.expires_at as string | Date).getTime() };
}

async function refreshFromZoho(): Promise<DcToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: Deno.env.get("ZOHO_DC_CLIENT_ID") ?? "",
    client_secret: Deno.env.get("ZOHO_DC_CLIENT_SECRET") ?? "",
    refresh_token: Deno.env.get("ZOHO_DC_REFRESH_TOKEN") ?? "",
  });
  const accounts = Deno.env.get("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.com";
  const r = await fetch(`${accounts}/oauth/v2/token`, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!j.access_token) throw signInError(j.error ?? `HTTP ${r.status}`);
  return { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
}

async function readShared(): Promise<DcToken | null> {
  const rows = await db()`select access_token, expires_at from dc.zoho_dc_token where id = 1`;
  const t = toToken(rows[0]);
  return fresh(t) ? t : null;
}

type Outcome = { kind: "token"; token: DcToken } | { kind: "refused"; error: string };

async function refreshOnce(): Promise<DcToken> {
  const outcome = (await db().begin(async (tx) => {
    await tx`select set_config('lock_timeout', ${LOCK_WAIT}, true)`;
    await tx`insert into dc.zoho_dc_token (id) values (1) on conflict (id) do nothing`;
    const rows = await tx`
      select access_token, expires_at, last_error, last_error_at
      from dc.zoho_dc_token where id = 1 for update`;
    const row = rows[0];

    const shared = toToken(row);
    if (fresh(shared)) return { kind: "token", token: shared };

    const failedAt = row?.last_error_at ? new Date(row.last_error_at as string | Date).getTime() : 0;
    if (row?.last_error && Date.now() - failedAt < FAILURE_HOLD_MS) {
      return { kind: "refused", error: String(row.last_error) };
    }

    try {
      const t = await refreshFromZoho();
      await tx`
        update dc.zoho_dc_token
        set access_token = ${t.value}, expires_at = ${new Date(t.expiresAt).toISOString()},
            refreshed_at = now(), last_error = null, last_error_at = null
        where id = 1`;
      return { kind: "token", token: t };
    } catch (err) {
      const zohoError = String((err as { zohoError?: unknown })?.zohoError ?? "unknown");
      await tx`
        update dc.zoho_dc_token
        set last_error = ${zohoError}, last_error_at = ${new Date().toISOString()}
        where id = 1`;
      return { kind: "refused", error: zohoError };
    }
  })) as Outcome;
  if (outcome.kind === "refused") throw signInError(outcome.error);
  return outcome.token;
}

function accessToken(): Promise<string> {
  if (fresh(token)) return Promise.resolve(token.value);
  inFlight ??= (async () => {
    token = (await readShared()) ?? (await refreshOnce());
    return token.value;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

const STALE_TOKEN_CODES = new Set(["INVALID_TOKEN", "AUTHENTICATION_FAILURE"]);
const STALE_TOKEN_TITLE = /invalid oauth ?token|token (has )?expired|invalid_token/i;

async function isStaleToken(r: Response): Promise<boolean> {
  try {
    const j = (await r.clone().json()) as { code?: unknown; errors?: { id?: unknown; title?: unknown }[] };
    if (typeof j.code === "string" && STALE_TOKEN_CODES.has(j.code)) return true;
    const e = j.errors?.[0];
    return (
      (typeof e?.id === "string" && STALE_TOKEN_CODES.has(e.id)) ||
      (typeof e?.title === "string" && STALE_TOKEN_TITLE.test(e.title))
    );
  } catch {
    return false;
  }
}

/** fetch with DC's token; retried once, fresh, only when a 401 says the token was bad. */
export async function dcFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const send = (value: string) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Zoho-oauthtoken ${value}` },
    });
  const used = await accessToken();
  const r = await send(used);
  if (r.status !== 401 || !(await isStaleToken(r))) return r;
  await r.body?.cancel();
  if (token?.value === used) token = null;
  await db()`update dc.zoho_dc_token set access_token = null, expires_at = null where id = 1 and access_token = ${used}`;
  return await send(await accessToken());
}

/** A Postgres connection for reading dc.deals, shared with the token store. */
export function dcDb() {
  return db();
}
