// lib/control.ts: words for components/Control.tsx.
//
// No React, so the tests read these directly.

/** What a button says while it works, unless it says something better. */
export const WORKING = "Working...";

/**
 * A failed press, in words a person can act on. A message written for people
 * comes through as it is; the browser's own wording for a dropped connection
 * becomes a sentence, and anything without a message says to try again.
 */
export function plainError(err: unknown): string {
  const message = err instanceof Error ? err.message.trim() : typeof err === "string" ? err.trim() : "";
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return "Could not reach DocuRide. Check the connection and try again.";
  }
  if (message === "" || /^[A-Z_]+$|^\w+Error\b|undefined|null|\[object /.test(message)) {
    return "That did not work. Try again.";
  }
  return message.endsWith(".") ? message : `${message}.`;
}
