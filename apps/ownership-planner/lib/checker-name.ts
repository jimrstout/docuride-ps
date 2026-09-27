// lib/checker-name.ts — the name on a verification, with no Next imports.
//
// Split from lib/checker.ts for the same reason lib/console-cookie.ts is split
// from lib/admin-session.ts: the cookie jar needs next/headers, and a test that
// wants to check the cleaning rules should not have to boot Next to do it.

export const CHECKER_COOKIE = "docuride_checker";

/** A year. The name of whoever works this desk does not change weekly. */
export const CHECKER_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: true,
  path: "/",
  maxAge: 365 * 24 * 60 * 60,
} as const;

/** Trimmed, length-capped, and with newlines out: it is going into a record. */
export function cleanCheckerName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
}
