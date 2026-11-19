// lib/admin-session-rules.ts
//
// When the console cookie still counts. The console carries its own signed
// cookie (lib/console-cookie.ts), and PS shares one sign-in with every other
// DocuRide app (lib/shared-sign-in.ts). Signing out anywhere removes the shared
// sign-in, so the console counts only while the shared sign-in is there and
// belongs to the same person. Signing out of HQ signs you out of PS at your
// next click, and someone else signing in on this computer is never shown the
// last person's console.
//
// No Next imports, so it is tested directly (test/ps-shared-sign-in.test.mjs).

import { CONSOLE_COOKIE, verifyConsoleCookie } from "./console-cookie.ts";
import { readSharedSession, sharedUserId } from "./shared-sign-in.ts";

/** The console cookie's value when it still counts, else null. */
export function liveConsoleCookie(
  get: (name: string) => string | undefined,
  secret?: string,
  now?: number
): string | null {
  const value = get(CONSOLE_COOKIE);
  if (!value) return null;
  const operator = verifyConsoleCookie(value, secret, now);
  if (!operator) return null;
  const shared = readSharedSession(get);
  if (!shared || sharedUserId(shared) !== operator.sub) return null;
  return value;
}
