// GET /api/sso?next=<staff page>: sign in with the shared DocuRide sign-in.
//
// The sign-in form sends people here when the request carries the session that
// HQ, FX, DC and R&R share (lib/shared-sign-in.ts). fni-admin-auth checks with
// Supabase whose session it is and whether they may use PS (the same rule as
// the password sign-in), and then the console cookie is set as usual.
//
// Every way this can't sign someone in goes back with a notice, and the form
// never sends anyone here while showing a notice, so it cannot loop.

import { NextResponse, type NextRequest } from "next/server";
import { edge, EdgeError } from "@/lib/edge";
import { CONSOLE_COOKIE, CONSOLE_COOKIE_OPTIONS, mintConsoleCookie } from "@/lib/admin-session";
import { safeStaffPath, withNotice } from "@/lib/admin-sections";
import {
  readSharedSession,
  refreshSharedSession,
  sharedSessionCookies,
  sharedTokenExpired,
  type CookieWrite,
} from "@/lib/shared-sign-in";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const next = safeStaffPath(req.nextUrl.searchParams.get("next"));
  const go = (path: string, writes: CookieWrite[] = []) => {
    const res = NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
    res.headers.set("Cache-Control", "no-store");
    for (const w of writes) res.cookies.set(w.name, w.value, w.options);
    return res;
  };

  let session = readSharedSession((name) => req.cookies.get(name)?.value);
  if (!session) return go(next);

  // The access token ran out while no DocuRide app was open: refresh it, and
  // hand the new session back to every app.
  let writes: CookieWrite[] = [];
  if (sharedTokenExpired(session)) {
    const url = process.env.SUPABASE_URL;
    const refreshed = url ? await refreshSharedSession(url, session) : null;
    if (!refreshed) return go(withNotice(next, "expired"));
    session = refreshed;
    const present = req.cookies.getAll().map((c) => c.name);
    writes = sharedSessionCookies(session, req.headers.get("host"), present);
  }

  let user: { user_id: string; email: string };
  try {
    user = await edge.adminAuthToken<{ user_id: string; email: string }>(session.access_token);
  } catch (err) {
    if (err instanceof EdgeError && err.status === 401) return go(withNotice(next, "nosso"), writes);
    if (err instanceof EdgeError && err.status === 429) return go(withNotice(next, "slow"), writes);
    console.error("shared sign-in failed:", err instanceof EdgeError ? err.status : "error");
    return go(withNotice(next, "broken"), writes);
  }

  const res = go(next, writes);
  res.cookies.set(CONSOLE_COOKIE, mintConsoleCookie({ sub: user.user_id, email: user.email }), CONSOLE_COOKIE_OPTIONS);
  return res;
}
