// lib/console-cookie.ts
//
// The internal console's sign-in cookie: who is signed in, until when, and a
// signature over both. Minting and verifying only — no Next, no request, no I/O,
// so the security-critical half can be exercised directly by test/console-cookie.
//
// ── Why there is no new environment variable ────────────────────────────
// The signing key is derived from FNI_WEBHOOK_SECRET, which this app already
// holds and cannot run without. HKDF makes the derived key one-way, so a cookie
// signature never leaks the secret, and the "info" string keeps this key
// disjoint from the secret's other use -- a value signed for one purpose can
// never be replayed as the other.
//
// Two things follow, and both are wanted. There is nothing to configure before
// the console works. And rotating FNI_WEBHOOK_SECRET signs everyone out, which
// is the correct consequence of a rotation rather than an inconvenience.
//
// ── Why a cookie rather than the Supabase session ───────────────────────
// Holding a Supabase access token would mean refreshing it, storing a refresh
// token far more powerful than "may read a list", and giving the console a
// credential that reaches the whole project. This proves one thing -- that a
// platform admin signed in less than twelve hours ago -- and is useless
// anywhere else.
//
// There is no "server-only" import here because the test imports it as a plain
// module. It cannot reach a browser bundle regardless: it imports node:crypto
// and reads a secret from process.env, and both fail the client build.

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const CONSOLE_COOKIE = "docuride_console";

/** A showroom day, and no longer. The console lists live buyer deals. */
export const CONSOLE_TTL_SECONDS = 12 * 60 * 60;

export type ConsoleSession = { sub: string; email: string; exp: number };

function signingKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, "docuride-ps-console", "admin session v1", 32)
  );
}

function requireSecret(): string {
  const secret = process.env.FNI_WEBHOOK_SECRET;
  if (!secret) throw new Error("FNI_WEBHOOK_SECRET is not set");
  return secret;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", signingKey(secret)).update(payload).digest("base64url");
}

/** Mint a cookie value for an operator who has just proved who they are. */
export function mintConsoleCookie(
  user: { sub: string; email: string },
  secret: string = requireSecret(),
  now: number = Date.now()
): string {
  const payload: ConsoleSession = {
    sub: user.sub,
    email: user.email,
    exp: Math.floor(now / 1000) + CONSOLE_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `v1.${encoded}.${sign(encoded, secret)}`;
}

/**
 * The signed-in operator, or null.
 *
 * Every rejection returns the same null. Missing, malformed, forged and merely
 * stale are all "not signed in" as far as the console is concerned, and there
 * is nothing useful to tell apart.
 */
export function verifyConsoleCookie(
  value: string | undefined,
  secret: string = requireSecret(),
  now: number = Date.now()
): ConsoleSession | null {
  if (!value) return null;

  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, encoded, presented] = parts;

  const a = Buffer.from(presented);
  const b = Buffer.from(sign(encoded, secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const { sub, email, exp } = parsed as Record<string, unknown>;
  if (typeof sub !== "string" || typeof email !== "string" || typeof exp !== "number") {
    return null;
  }
  if (exp <= Math.floor(now / 1000)) return null;

  return { sub, email, exp };
}

/** The cookie attributes. Collected here so the two writers cannot drift. */
export const CONSOLE_COOKIE_OPTIONS = {
  httpOnly: true,
  // The console is only ever served over https; a cookie that would also go out
  // over http is a cookie that can be stripped off the wire.
  secure: true,
  // The cookie authorizes a write -- extending an expiry -- so a cross-site POST
  // must not carry it. Strict also means arriving from a link in an email shows
  // the sign-in form once, which is the right trade for an internal tool.
  sameSite: "strict" as const,
  path: "/",
  maxAge: CONSOLE_TTL_SECONDS,
};
