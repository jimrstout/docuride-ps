// lib/next-step.ts: the one next step Details offers.
//
// Exactly one main button at a time, in the bar along the bottom of Details:
//   rate     not yet rated, or the rating is out of date: Rate. No
//            presentation buttons at all, since there is nothing to present.
//   prepare  rated and current, Prepare presentation not saved yet: Prepare
//            presentation. Rate again beside it; both presentations shown,
//            disabled, with "Prepare the presentation first."
//   present  prepared: Present menu and Present storyboard. Prepare
//            presentation (to change it) and Rate again beside them.
// No Next imports, so it can be tested directly.

export type NextStep = "rate" | "prepare" | "present";

/**
 * `presentable` is verified, rated and current. `prepared` is the session's
 * own record that Prepare presentation was saved (sheet.prepared, from
 * menu_prepared_at, migration 0045).
 */
export function nextStep(presentable: boolean, prepared: boolean): NextStep {
  return !presentable ? "rate" : !prepared ? "prepare" : "present";
}

/** Why the presentations wait, in the words the disabled buttons carry. */
export const PREPARE_FIRST = "Prepare the presentation first.";

/**
 * What Rate does, said beside the button. No provider's name: the line is
 * about the record kept, not about who answers.
 */
export const RATE_SAY =
  "Every required field has a value. Rating records your name, the time, and each value with its source.";
