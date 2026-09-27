// lib/checker.ts — whose name goes on a verification, with no sign-in.
//
// ── Why this exists at all ───────────────────────────────────────────────
// The Verify screen is opened straight from the CRM button and has no login.
// But fni-session-verify refuses a verification with nobody's name on it, on
// purpose: the snapshot is the answer to "who said this price was right", and
// "unknown" is not an answer. So the name has to come from somewhere, and with
// no accounts the only place left is the person typing it.
//
// One box, once per device, remembered in a cookie. It reads like a name badge
// rather than a sign-in, which is exactly what it is.
//
// ── This cookie is NOT security, and must never be read as security ──────
// It is unsigned and anybody can set it to anything. That is acceptable because
// it authorises nothing: reaching the Verify screen is governed by holding the
// session link, the same as the presentation. Treating this value as proof of
// identity would be a mistake; it is a label on a record, and the record's own
// protection is that the link is unguessable.
//
// The cleaning rules and the cookie's shape live in lib/checker-name.ts, which
// has no Next imports so it can be tested directly. This is the thin part that
// reads the current request's cookie jar.

import "server-only";
import { cookies } from "next/headers";
import { CHECKER_COOKIE, cleanCheckerName } from "./checker-name";

export {
  CHECKER_COOKIE,
  CHECKER_COOKIE_OPTIONS,
  cleanCheckerName,
} from "./checker-name";

/** The name on this device, or an empty string if nobody has said. */
export async function currentChecker(): Promise<string> {
  const jar = await cookies();
  return cleanCheckerName(jar.get(CHECKER_COOKIE)?.value);
}

/**
 * The name to record for this action: what was posted, else what the device
 * remembers.
 *
 * Posted first so that typing a new name in the box and pressing the button in
 * one go does what it looks like it does.
 */
export async function checkerFor(formData: FormData): Promise<string> {
  const posted = cleanCheckerName(formData.get("checker_name"));
  if (posted !== "") return posted;
  return await currentChecker();
}
