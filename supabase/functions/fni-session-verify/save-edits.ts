// fni-session-verify/save-edits.ts
//
// Whether a posted value is a staff edit, or the value the deal already has.
//
// ── The bug this exists to end ──────────────────────────────────────────
// The Verify form posts every input, each pre-filled with what the sheet
// showed. save() used to record any non-blank posted value as an edit, so one
// press of Save changes turned every field into "Edited by Staff, was <the
// same value>". Session 9906521b showed it on all of them.
//
// So a posted value is compared with the unedited value for the same field, by
// MEANING rather than by string: both sides go through the same cast the value
// is applied with. "$24,999.00", "24,999" and "24999" are one price; "6.99%" and
// "6.99" one rate; "Finance" and "Loan" one deal type; a date in either accepted
// format one date. Equal means no edit, and it also clears an earlier edit, so
// setting a field back to what the deal says is the same as clearing the box.
//
// Its own file, with no remote imports, so the rule can be tested from Node.
// index.ts pulls `serve` from deno.land and cannot be.

import {
  castForColumn,
  castForProperty,
  type EditTarget,
  type StaffEdit,
} from "../_shared/staff-edits.ts";

/** The value a field would take effect as, or null if it cannot be read. */
function castFor(target: EditTarget | null, raw: string): string | null {
  if (target === null) {
    const v = raw.trim();
    return v === "" ? null : v;
  }
  const cast = target.kind === "column"
    ? castForColumn(target, raw)
    : castForProperty(target, raw);
  return cast === null || cast === undefined ? null : String(cast);
}

/**
 * Does the posted value mean the same as the unedited one?
 *
 * An unedited value of null is never the same as a posted value: typing into
 * an empty field is always a real edit.
 */
export function sameAsUnedited(
  target: EditTarget | null,
  posted: string,
  unedited: string | null
): boolean {
  if (unedited === null) return false;
  const a = castFor(target, posted);
  const b = castFor(target, unedited);
  return a !== null && b !== null && a === b;
}

/**
 * The edit to keep for one posted field, or null to keep none.
 *
 * `posted` has already passed the unreadable checks, and is the form to store:
 * the word for fuel type, the text as typed for everything else.
 */
export function editFor(
  target: EditTarget | null,
  posted: string,
  unedited: { value: string | null; source: string } | undefined,
  existing: StaffEdit | undefined,
  editedBy: string,
  now: string
): StaffEdit | null {
  if (sameAsUnedited(target, posted, unedited?.value ?? null)) return null;

  return {
    value: posted,
    // An existing edit keeps its first original. Editing a price twice still
    // records what the CRM said, not what the last person typed.
    original: existing ? existing.original : (unedited?.value ?? null),
    original_source: existing ? existing.original_source : (unedited?.source ?? "Missing"),
    edited_by: editedBy,
    edited_at: now,
  };
}
