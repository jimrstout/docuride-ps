"use server";

// app/console-actions.ts — the console's three writes.
//
// Server Actions rather than route handlers, and plain <form> elements rather
// than fetch, so the console works with no client JavaScript at all. That is
// not purity: it is the shortest path between "I clicked extend" and "the row
// says it is live again", with nothing in between that can be out of date.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { edge, EdgeError } from "@/lib/edge";
import {
  CONSOLE_COOKIE,
  CONSOLE_COOKIE_OPTIONS,
  currentOperator,
  mintConsoleCookie,
} from "@/lib/admin-session";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** How much one press of Extend is worth. The same 24 hours a session starts
 *  with, so "extend" restores a session to the state it was created in. */
const EXTEND_HOURS = 24;

export async function signIn(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!email || !password) redirect("/?denied=1");

  let user: { user_id: string; email: string };
  try {
    user = await edge.adminAuth<{ user_id: string; email: string }>(email, password);
  } catch (err) {
    if (err instanceof EdgeError && err.status === 429) redirect("/?slow=1");
    if (err instanceof EdgeError && err.status === 401) redirect("/?denied=1");
    // A misconfigured secret and a Supabase outage both land here. Neither is
    // the operator's fault and neither is "wrong password", so they do not get
    // told it was.
    console.error("console sign-in failed:", err);
    redirect("/?broken=1");
  }

  const jar = await cookies();
  jar.set(
    CONSOLE_COOKIE,
    mintConsoleCookie({ sub: user.user_id, email: user.email }),
    CONSOLE_COOKIE_OPTIONS
  );

  redirect("/");
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(CONSOLE_COOKIE);
  redirect("/");
}

export async function extendSession(formData: FormData): Promise<void> {
  // Checked here and not only on the page: a Server Action is a POST endpoint
  // like any other, and the page having rendered the button is not evidence
  // that whoever called it was allowed to.
  const operator = await currentOperator();
  if (!operator) redirect("/");

  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect("/?bad=1");

  try {
    await edge.adminExtend<{ expires_at: string }>(sessionId, EXTEND_HOURS);
  } catch (err) {
    console.error(`console extend failed for ${sessionId}:`, err);
    redirect("/?extendfailed=1");
  }

  // The list is the feedback: the row's expiry moves and the Expired mark
  // clears. Nothing else needs to be said.
  revalidatePath("/");
  redirect("/");
}
