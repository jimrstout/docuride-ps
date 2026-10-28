// _shared/session-reopen.ts
//
// A session whose every contract has been voided is open again.
//
// Getting every contract document moves a session to Finalized
// (fni-contract-documents), and voiding never moved it back, so Submit went on
// refusing with "Session is Finalized." even with nothing live (deal 15029,
// 28 Oct 2026). Now the void that leaves a session with no live contract puts
// it back to Products Selected, where the customer's choices put it.
//
// "Live" is the rule the contract panels already lock on (occupiesSlot): a
// contract that is Live or Submit Status Unknown. A session whose own submit
// is In Progress or Submit Status Unknown is left alone, since contracts may
// exist there that are not recorded yet. Only the status changes: the
// selected products, rated offers, verification, dates and prices are as
// they were.
//
// Pure rules here, with the one write that applies them.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { occupiesSlot, type ContractRef } from "./duplicates.ts";
import { renewedBy } from "./sale-date.ts";

export const REOPENED_STATUS = "Products Selected";

/** The statuses a session has once contracts were submitted for it. */
export const REOPENS_FROM: readonly string[] = ["Agreement Created", "Finalized"];

export const REOPENED_EVENT = "Session reopened: all contracts voided";

/**
 * Should this session reopen? It has contracts, none of them live, its own
 * submit is idle, and its status is one a submit put it in.
 */
export function shouldReopen(
  status: unknown,
  submitState: unknown,
  contracts: Pick<ContractRef, "status">[]
): boolean {
  if (typeof status !== "string" || !REOPENS_FROM.includes(status)) return false;
  if ((submitState ?? "Idle") !== "Idle") return false;
  if (contracts.length === 0) return false;
  return !contracts.some((c) => occupiesSlot(c as ContractRef));
}

/**
 * After a void: reopen the session if nothing on it is live any more, and
 * record that as a session event by the person's initials, or System.
 * Returns whether it reopened. A failure here is logged, never thrown: the
 * void itself is done and must still be reported as done.
 */
export async function reopenIfAllVoided(
  supabase: SupabaseClient,
  sessionId: string,
  initials: unknown
): Promise<boolean> {
  try {
    const { data: session } = await supabase
      .schema("fni")
      .from("sessions")
      .select("status, submit_state")
      .eq("id", sessionId)
      .maybeSingle();
    if (!session) return false;

    const { data: agreements } = await supabase
      .schema("fni")
      .from("agreements")
      .select("id")
      .eq("session_id", sessionId);
    const ids = ((agreements ?? []) as { id: string }[]).map((a) => a.id);
    if (ids.length === 0) return false;

    const { data: rows, error: rowErr } = await supabase
      .schema("fni")
      .from("agreement_products")
      .select("status")
      .in("agreement_id", ids);
    if (rowErr) throw new Error(rowErr.message);

    const s = session as { status: string; submit_state: string | null };
    if (!shouldReopen(s.status, s.submit_state, (rows ?? []) as { status: string }[])) return false;

    // Conditional, so a submit that starts meanwhile (submit_state leaves
    // Idle) or a status that moved on is never overwritten.
    const { data: reopened, error: updErr } = await supabase
      .schema("fni")
      .from("sessions")
      .update({ status: REOPENED_STATUS })
      .eq("id", sessionId)
      .in("status", [...REOPENS_FROM])
      .eq("submit_state", "Idle")
      .select("id")
      .maybeSingle();
    if (updErr) throw new Error(updErr.message);
    if (!reopened) return false;

    const { error: eventErr } = await supabase
      .schema("fni")
      .from("session_events")
      .insert({
        session_id: sessionId,
        event: REOPENED_EVENT,
        detail: { from: s.status, to: REOPENED_STATUS },
        created_by: renewedBy(initials),
      });
    if (eventErr) console.error(`reopen event not recorded for ${sessionId}: ${eventErr.message}`);
    console.log(`session ${sessionId} reopened from ${s.status}: all contracts voided`);
    return true;
  } catch (err) {
    console.error(`session ${sessionId} could not be reopened after a void: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
