// lib/admin-session.ts — the console's sign-in as the request sees it.
//
// The cookie's format, signing and expiry all live in lib/console-cookie.ts,
// which has no Next imports so it can be tested directly. This is the thin part
// that reads the current request's cookie jar.

import "server-only";
import { cookies } from "next/headers";
import { type ConsoleSession, CONSOLE_COOKIE, verifyConsoleCookie } from "./console-cookie";

export {
  CONSOLE_COOKIE,
  CONSOLE_COOKIE_OPTIONS,
  CONSOLE_TTL_SECONDS,
  mintConsoleCookie,
  verifyConsoleCookie,
} from "./console-cookie";
export type { ConsoleSession } from "./console-cookie";

/** The signed-in operator for the current request, or null. */
export async function currentOperator(): Promise<ConsoleSession | null> {
  const jar = await cookies();
  return verifyConsoleCookie(jar.get(CONSOLE_COOKIE)?.value);
}
