"use server";

// app/prepare/[sessionId]/actions.ts: saving Prepare menu.
//
// Signed-in staff only. A price outside the staff range needs a manager to sign in on
// the screen and give a reason: their email and password are checked here
// through fni-admin-auth, never kept, and fni-menu-prepare checks the manager
// role (fni.is_menu_manager) before saving. The manager's name and the reason
// go in a session event.

import { revalidatePath } from "next/cache";
import { edge, EdgeError } from "@/lib/edge";
import { currentOperator } from "@/lib/admin-session";
import { initialsFor, nameFromEmail } from "@/lib/admin-sections";
import type { PreparePayload } from "@/lib/prepare-model";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PrepareResult = { ok: true; payload: PreparePayload } | { ok: false; error: string };

function why(err: unknown): string {
  if (err instanceof EdgeError && err.status >= 400 && err.status < 500) {
    const detail = (err.body as { error?: unknown } | undefined)?.error;
    if (typeof detail === "string") return detail.slice(0, 600);
  }
  return "That could not be saved just now. Nothing was changed. Try again shortly.";
}

export async function savePreparedMenu(
  sessionId: string,
  prepared: {
    cells: Record<string, Record<string, string | null>>;
    prices: Record<string, number>;
    surcharges: string[];
    terms?: Record<string, { months: number; rate: number }[]>;
  },
  manager: { email: string; password: string; reason: string } | null
): Promise<PrepareResult> {
  const operator = await currentOperator();
  if (!operator) return { ok: false, error: "Sign in to prepare the menu." };
  if (!UUID_RE.test(sessionId)) return { ok: false, error: "That is not a session." };

  let approval: { manager_id: string; manager_name: string; reason: string } | Record<string, never> = {};
  if (manager) {
    if (manager.reason.trim() === "") return { ok: false, error: "Give a reason for the price outside the staff range." };
    try {
      const signedIn = await edge.adminAuth<{ user_id: string; email: string }>(manager.email.trim(), manager.password);
      approval = { manager_id: signedIn.user_id, manager_name: nameFromEmail(signedIn.email), reason: manager.reason.trim() };
    } catch {
      return { ok: false, error: "That manager sign-in was not accepted." };
    }
  }

  try {
    const payload = await edge.menuPrepareSave<PreparePayload>({
      session_id: sessionId,
      action: "save",
      ...prepared,
      set_by: initialsFor(operator.email),
      ...approval,
    });
    revalidatePath(`/prepare/${sessionId}`);
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, error: why(err) };
  }
}

/** The menu back to its prepared state: products the customer removed come back. Recorded. */
export async function resetPreparedMenu(sessionId: string): Promise<PrepareResult> {
  const operator = await currentOperator();
  if (!operator) return { ok: false, error: "Sign in to prepare the menu." };
  if (!UUID_RE.test(sessionId)) return { ok: false, error: "That is not a session." };
  try {
    const payload = await edge.menuPrepareSave<PreparePayload>({ session_id: sessionId, action: "reset", set_by: initialsFor(operator.email) });
    revalidatePath(`/prepare/${sessionId}`);
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, error: why(err) };
  }
}

/** Back to Prepare menu after the customer chose a package: prices unlock, and that is recorded. */
export async function unlockPreparedMenu(sessionId: string): Promise<PrepareResult> {
  const operator = await currentOperator();
  if (!operator) return { ok: false, error: "Sign in to prepare the menu." };
  if (!UUID_RE.test(sessionId)) return { ok: false, error: "That is not a session." };
  try {
    const payload = await edge.menuPrepareSave<PreparePayload>({ session_id: sessionId, action: "unlock", set_by: initialsFor(operator.email) });
    revalidatePath(`/prepare/${sessionId}`);
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, error: why(err) };
  }
}
