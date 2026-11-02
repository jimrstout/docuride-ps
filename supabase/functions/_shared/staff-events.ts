// _shared/staff-events.ts: who did what on Details, as session events.
//
// Each recorded action on Details credits the signed-in staff member: the
// event says what happened, created_by carries their initials, the way
// "Menu prepared" and "Rated again by JS" already do. The person comes from
// the staff sign-in the function checked (_shared/staff-gate.ts), never from
// a name typed on the page: the Checked by box is gone.
//
// The detail names what changed, never a value: values stay in the session's
// own staff edits, where they always were.

/** Details' Rate: the inputs were checked and recorded, then rated. */
export const VERIFIED_EVENT = "Verified for rating";
/** Save changes on the deal sheet. Detail: the field keys. */
export const SHEET_SAVED_EVENT = "Deal sheet changed";
/** A buyer, co-buyer or lienholder change. Detail: the action, and the party or field. */
export const PARTIES_CHANGED_EVENT = "Who goes on the contracts changed";
/** Discard my edits and reload from CRM. */
export const EDITS_DISCARDED_EVENT = "Edits discarded and reloaded from CRM";
/** Refresh from CRM. */
export const REFRESHED_EVENT = "Refreshed from CRM";
/** The menu's coverage levels for this deal. */
export const MENU_LEVELS_EVENT = "Menu coverage levels set";

type Inserter = {
  schema: (s: string) => {
    from: (t: string) => { insert: (row: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }> };
  };
};

/**
 * Record one. A failure is logged and never undoes the action it describes,
 * which has already happened.
 */
export async function recordStaffEvent(
  supabase: Inserter,
  sessionId: string,
  event: string,
  who: string,
  detail: Record<string, unknown> | null = null,
): Promise<void> {
  const { error } = await supabase
    .schema("fni")
    .from("session_events")
    .insert({ session_id: sessionId, event, detail, created_by: who });
  if (error) console.error("staff event not recorded", { session: sessionId, event, code: error.message.slice(0, 80) });
}
