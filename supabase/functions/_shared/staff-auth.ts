// _shared/staff-auth.ts: who is signed in, and may they open this deal.
//
// ── Why the Edge Functions check this themselves ─────────────────────────
// Every staff function used to trust FNI_WEBHOOK_SECRET alone. The Next server
// holds that secret and forwarded every request, so anyone holding a deal's
// link reached its data through the server: the server was the only gate, and
// for Details and the presentations it did not check anybody. Now each staff
// function also asks for the staff sign-in itself, so a page that forgets to
// check cannot leak a deal.
//
// ── The credential ───────────────────────────────────────────────────────
// The staff sign-in cookie the Next server already issues (docuride_console,
// apps/ownership-planner/lib/console-cookie.ts), forwarded unchanged in the
// x-staff-session header. It is an HMAC over { sub, email, exp }, keyed by
// HKDF from FNI_WEBHOOK_SECRET, which every fni function already holds, so
// there is nothing new to configure. The signature here is the same one, in
// WebCrypto rather than node:crypto; test/staff-auth.test.mjs checks that a
// cookie the Next side mints is accepted here, and an edited one is not.
//
// ── The access rule ──────────────────────────────────────────────────────
// The cookie says who. public.profiles says what they may open, read fresh on
// every request, so removing someone's profile or a store from it takes effect
// at once, not when their cookie runs out:
//   - a platform admin may open any deal;
//   - anyone else must belong to the deal's tenant AND list the deal's store
//     in profiles.store_ids. No stores listed means no deals, never all.
//   - a deal with no tenant or no store is platform admins only.
//
// Pure: no Deno, no network. The loaders are passed in, so the node tests run
// the same code the functions do. _shared/staff-gate.ts wires the real ones.

export const STAFF_HEADER = "x-staff-session";

export type StaffSession = { sub: string; email: string; exp: number };

export type StaffProfile = {
  user_id: string;
  tenant_id: string | null;
  store_ids: string[] | null;
  is_platform_admin: boolean | null;
};

export type DealScope = { tenant_id: string | null; store_id: string | null };

export type StaffDecision =
  | { ok: true; staff: StaffSession; profile: StaffProfile }
  | { ok: false; status: 401 | 403 | 404; error: string };

/** Said the same way for every refusal: nothing about the deal, the person or why. */
export const SIGN_IN_REQUIRED = "Sign in as dealership staff to open this.";
export const NOT_YOUR_STORE = "Your sign-in does not cover this deal's store.";

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): string | null {
  try {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Constant time over equal lengths. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HKDF-SHA256(secret, "docuride-ps-console", "admin session v1"), as lib/console-cookie.ts. */
async function signature(payload: string, secret: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const ikm = await subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("docuride-ps-console"), info: enc.encode("admin session v1") },
    ikm,
    256,
  );
  const key = await subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await subtle.sign("HMAC", key, enc.encode(payload))));
}

/**
 * The signed-in staff member the cookie names, or null. Missing, malformed,
 * forged and expired are all the same null.
 */
export async function verifyStaffToken(
  value: string | null | undefined,
  secret: string | null | undefined,
  now: number = Date.now(),
): Promise<StaffSession | null> {
  if (!value || !secret) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, encoded, presented] = parts;
  if (!same(presented, await signature(encoded, secret))) return null;

  const text = fromB64url(encoded);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { sub, email, exp } = parsed as Record<string, unknown>;
  if (typeof sub !== "string" || typeof email !== "string" || typeof exp !== "number") return null;
  if (exp <= Math.floor(now / 1000)) return null;
  return { sub, email, exp };
}

/** May this profile open a deal in this tenant and store? */
export function staffMayOpen(profile: StaffProfile, deal: DealScope): boolean {
  if (profile.is_platform_admin === true) return true;
  if (!deal.tenant_id || !deal.store_id) return false;
  if (!profile.tenant_id || profile.tenant_id !== deal.tenant_id) return false;
  return (profile.store_ids ?? []).includes(deal.store_id);
}

/**
 * The whole check for one request.
 *
 * `deal` is a loader, not a value, so a refused sign-in never causes a read of
 * the deal. Pass null for a function that serves no single deal (the admin
 * area's lists and settings): those span every tenant, so they are platform
 * admins only.
 */
export async function decideStaff(input: {
  token: string | null | undefined;
  secret: string | null | undefined;
  now?: number;
  profile: (userId: string) => Promise<StaffProfile | null>;
  deal: (() => Promise<DealScope | null>) | null;
}): Promise<StaffDecision> {
  const staff = await verifyStaffToken(input.token, input.secret, input.now);
  if (!staff) return { ok: false, status: 401, error: SIGN_IN_REQUIRED };

  const profile = await input.profile(staff.sub);
  if (!profile) return { ok: false, status: 401, error: SIGN_IN_REQUIRED };

  if (input.deal === null) {
    return profile.is_platform_admin === true
      ? { ok: true, staff, profile }
      : { ok: false, status: 403, error: NOT_YOUR_STORE };
  }

  const deal = await input.deal();
  if (!deal) {
    // Only a platform admin learns that a deal does not exist. Anyone else is
    // told the same thing as for a deal in another store.
    return profile.is_platform_admin === true
      ? { ok: false, status: 404, error: "Session not found" }
      : { ok: false, status: 403, error: NOT_YOUR_STORE };
  }
  return staffMayOpen(profile, deal)
    ? { ok: true, staff, profile }
    : { ok: false, status: 403, error: NOT_YOUR_STORE };
}

/**
 * Two letters for the signed-in person, from their email: "jim.stout@x" is
 * JS, "jim@x" is JI. The same rule as the Next side's initialsFor
 * (apps/ownership-planner/lib/admin-sections.ts), so a session event reads
 * the same whichever side wrote it. test/staff-credit.test.mjs holds the two
 * together.
 */
export function staffInitials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._\-+]+/).filter((p) => /[a-z0-9]/i.test(p));
  const letters =
    parts.length >= 2 ? parts[0][0] + parts[1][0] : (parts[0] ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 2);
  return (letters || "?").toUpperCase();
}
