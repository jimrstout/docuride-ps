// lib/shared-sign-in.ts
//
// The one DocuRide sign-in that every app shares. HQ, FX, DC and R&R keep the
// person's Supabase session in a cookie for the whole docuride.com domain
// (docuride-hq app/lib/shared-session.ts is the reference). The browser sends
// it here too, so the PS server can read it, have fni-admin-auth check who it
// belongs to and whether they may use PS, and then sign them in to the console
// the usual way (lib/console-cookie.ts). Nobody types a password twice.
//
// The console still carries its own short-lived cookie. The Supabase session
// is read only on the way in, and written back only when PS has to refresh it
// (so every app keeps the newest refresh token).
//
// No Next imports and no I/O except refreshSharedSession, so the format is
// tested directly (test/ps-shared-sign-in.test.mjs).

/** The cookie name every DocuRide app uses for this Supabase project (Supabase's default key). */
export const SHARED_KEY = "sb-fovccigwlcmmzfubpfny-auth-token";

/**
 * The project's publishable key. Public by design (every DocuRide page ships
 * it to the browser); it identifies the project and grants nothing alone.
 * Used here only to refresh an expired shared session.
 */
export const PUBLISHABLE_KEY = "sb_publishable_s4cFTF1i1Wff1m3n7zmg5A_9re6X7yj";

const CHUNK = 3500;
const MAX_CHUNKS = 10;
export const SHARED_MAX_AGE = 60 * 60 * 24 * 400;

export type SharedSession = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  [k: string]: unknown;
};

export type CookieWrite = {
  name: string;
  value: string;
  options: { path: "/"; maxAge: number; sameSite: "lax"; secure: boolean; httpOnly: false; domain?: string };
};

/** The parent domain the shared cookie lives on, or undefined to keep it on this host. */
export function sharedCookieDomain(host: string | null | undefined): string | undefined {
  const h = String(host ?? "").toLowerCase().split(":")[0];
  return h === "docuride.com" || h.endsWith(".docuride.com") ? "docuride.com" : undefined;
}

/** The shared session from the request's cookies, or null when there is none or it is unreadable. */
export function readSharedSession(get: (name: string) => string | undefined): SharedSession | null {
  let data = "";
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const part = get(`${SHARED_KEY}.${i}`);
    if (part === undefined) break;
    data += part;
  }
  if (!data) return null;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as Partial<SharedSession>;
    if (typeof s.access_token !== "string" || !s.access_token || typeof s.refresh_token !== "string" || !s.refresh_token) return null;
    return { ...s, expires_at: Number(s.expires_at) || 0 } as SharedSession;
  } catch {
    return null;
  }
}

/** True when the access token is expired, or will be within the next minute. */
export function sharedTokenExpired(s: SharedSession, nowMs: number = Date.now()): boolean {
  return s.expires_at - 60 <= nowMs / 1000;
}

function options(host: string | null | undefined, maxAge: number): CookieWrite["options"] {
  const domain = sharedCookieDomain(host);
  return { path: "/", maxAge, sameSite: "lax", secure: true, httpOnly: false, ...(domain ? { domain } : {}) };
}

/**
 * The cookies that store a session in the shared format, plus deletions for
 * leftover pieces of a longer one. Readable by every app's page script
 * (Supabase's client needs that), so never httpOnly.
 */
export function sharedSessionCookies(s: SharedSession, host: string | null | undefined, present: string[] = []): CookieWrite[] {
  const data = Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
  const parts = Math.ceil(data.length / CHUNK);
  if (parts > MAX_CHUNKS) throw new Error("Session too large to share");
  const out: CookieWrite[] = [];
  for (let i = 0; i < parts; i++) {
    out.push({ name: `${SHARED_KEY}.${i}`, value: data.slice(i * CHUNK, (i + 1) * CHUNK), options: options(host, SHARED_MAX_AGE) });
  }
  for (let i = parts; i < MAX_CHUNKS; i++) {
    if (present.includes(`${SHARED_KEY}.${i}`)) out.push({ name: `${SHARED_KEY}.${i}`, value: "", options: options(host, 0) });
  }
  return out;
}

/** Deletions for every piece of the shared session present: signing out of PS signs out everywhere. */
export function clearSharedCookies(present: string[], host: string | null | undefined): CookieWrite[] {
  return present
    .filter((n) => n.startsWith(`${SHARED_KEY}.`))
    .map((name) => ({ name, value: "", options: options(host, 0) }));
}

/**
 * Supabase's refresh, for a shared session whose access token ran out while
 * no DocuRide app was open. Returns the new session in Supabase's own shape,
 * or null when the refresh token is no longer good (sign in again).
 */
export async function refreshSharedSession(
  supabaseUrl: string,
  s: SharedSession,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now()
): Promise<SharedSession | null> {
  try {
    const r = await fetchFn(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown>;
    if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string") return null;
    const expiresIn = Number(j.expires_in) || 3600;
    const expiresAt = Number(j.expires_at) || Math.floor(nowMs / 1000) + expiresIn;
    return { ...j, access_token: j.access_token, refresh_token: j.refresh_token, expires_in: expiresIn, expires_at: expiresAt, token_type: "bearer" };
  } catch {
    return null;
  }
}

/** Whose shared session this is: the user Supabase stored with it, else the access token's subject. */
export function sharedUserId(s: SharedSession): string | null {
  const user = s.user as { id?: unknown } | undefined;
  if (user && typeof user.id === "string" && user.id) return user.id;
  try {
    const claims = JSON.parse(Buffer.from(s.access_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
    return typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}
