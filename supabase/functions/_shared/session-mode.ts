// _shared/session-mode.ts
//
// How a planning session was run. A presentation detail, not a separate build --
// there is one application and mode only changes who is driving it -- but the
// acknowledgment document has to state which it was, so the vocabulary is
// defined once here rather than spelled out at each call site.
//
// Title case, matching every other constrained column on fni.sessions:
// Individual / Company, New / Used, Loan / Lease / Cash, and the status values
// Initiated through Cancelled. `mode` was the only one out of step.

export const SESSION_MODES = [
  "Self-Guided",
  "Collaborative",
  "Staff-Presented",
] as const;

export type SessionMode = (typeof SESSION_MODES)[number];

export function isSessionMode(v: unknown): v is SessionMode {
  return typeof v === "string" && (SESSION_MODES as readonly string[]).includes(v);
}

/**
 * How the mode reads to a buyer on the acknowledgment.
 *
 * A Collaborative session used to print "Self-guided" here, because the label
 * was a two-way check on Staff-Presented. That is a false statement on a
 * document somebody signs, so all three modes name themselves.
 *
 * An unset mode reads as self-guided: a session nobody marked is one nobody
 * was driving.
 */
export function modeLabel(mode: string | null | undefined): string {
  switch (mode) {
    case "Staff-Presented":
      return "Presented by dealership staff";
    case "Collaborative":
      return "Presented with dealership staff";
    case "Self-Guided":
    default:
      return "Self-guided";
  }
}
