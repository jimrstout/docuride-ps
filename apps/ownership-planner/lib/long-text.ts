// lib/long-text.ts: the short form of a long message, for a small screen.
//
// A rating failure from TecAssured can run to five hundred characters. On a
// phone that fills the screen, so it is shown cut at a word boundary with a
// "Show details" toggle (components/LongText.tsx). No React, so a Node test
// can hold it.

/** The default length of the short form: about two lines on a phone. */
export const SHORT_TEXT_CHARS = 120;

/**
 * The text cut to at most `max` characters at a word boundary, with "..." when
 * anything was cut. The text itself when it already fits.
 */
export function shortText(text: string, max = SHORT_TEXT_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  const head = (space > max * 0.6 ? cut.slice(0, space) : t.slice(0, max)).replace(/[\s.,:;]+$/, "");
  return `${head}...`;
}
