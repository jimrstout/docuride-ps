"use server";

// app/console-actions.ts — the console's writes.
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


/**
 * Ask TecAssured for a session's menu again.
 *
 * The planner rates a session once, on its first load, and then never again on
 * its own: a session that has already been answered is not re-asked, so a deal
 * that failed cannot turn a reload into a stream of provider calls. That leaves
 * recovery to a person, which is what this is.
 *
 * Use it after fixing whatever stopped the rate: an engine size entered, a body
 * type mapped, the deal corrected in the CRM. A success replaces the row and the
 * customer's next page load shows the menu.
 */
export async function rateSession(formData: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect("/");

  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect("/?bad=1");

  try {
    await edge.adminRate<{ product_count?: number }>(sessionId);
  } catch (err) {
    // fni-rate-vehicle has already recorded the Failed row and its reason, so
    // the row in the list will say what went wrong. Nothing to add here beyond
    // a server-side log.
    console.error(`console re-rate failed for ${sessionId}:`, err);
  }

  // The Rating column is the feedback either way: it shows the new state and,
  // on a failure, the new reason.
  revalidatePath("/");
  redirect("/");
}


/**
 * Save the dealer group name and the copy that uses it.
 *
 * The Edge Function is the one that validates: it refuses a placeholder the
 * sentence does not have, and it treats a blank wording as "revert to the
 * platform default" by deleting this tenant's row. Its message is passed
 * straight back rather than reworded, because it says exactly what is wrong and
 * a second wording of the same problem is one more thing to keep in step.
 */
export async function saveSettings(formData: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect("/settings");

  const name = String(formData.get("dealer_group_display_name") ?? "");

  // Sent as a nested object so one form can carry several templates later
  // without the action learning about each one.
  const templates: Record<string, string> = {};
  for (const [field, value] of formData.entries()) {
    if (field.startsWith("template:")) {
      templates[field.slice("template:".length)] = String(value);
    }
  }

  try {
    await edge.adminSaveSettings({
      dealer_group_display_name: name,
      ...(Object.keys(templates).length > 0 ? { templates } : {}),
    });
  } catch (err) {
    if (err instanceof EdgeError && err.status === 400) {
      const detail =
        typeof (err.body as { error?: unknown } | undefined)?.error === "string"
          ? String((err.body as { error: string }).error)
          : "That could not be saved.";
      redirect(`/settings?refused=${encodeURIComponent(detail.slice(0, 300))}`);
    }
    console.error("console settings save failed:", err);
    redirect("/settings?savefailed=1");
  }

  revalidatePath("/settings");
  redirect("/settings?saved=1");
}
