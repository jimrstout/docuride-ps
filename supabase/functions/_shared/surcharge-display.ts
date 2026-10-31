// _shared/surcharge-display.ts
//
// Surcharge names as people read them (docs/multi-provider.md section 27).
// Providers send them as they keep them: "GPS EQUIPPED", "Commercial Use - All
// Dealers". Shown in plain title case, without the provider's dealer suffix:
// "GPS Equipped", "Commercial Use". For display only: the provider's own code
// (the option's `unique`) is what is saved and submitted, unchanged.
//
// Pure, so a Node test can hold it. apps/ownership-planner/lib/surcharge-display.ts
// carries the same words for the browser.

/** Kept in capitals: they are read as letters. */
const ACRONYMS = new Set(["GPS", "HVAC", "RV", "ATV", "UTV", "UTVS", "ATVS", "VIN", "LED", "AC", "AWD", "4WD", "4X4", "GAP", "OEM", "PTO", "USB"]);

/** Small words lower case inside a name, as title case has them. */
const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

/** " - All Dealers", " - Participating Dealers", "- Select Dealer": the provider's, not the customer's. */
const DEALER_SUFFIX = /\s*-\s*(?:all|participating|select|selected|certain)\s+dealers?\s*$/i;

function titleWord(w: string, first: boolean): string {
  if (ACRONYMS.has(w.toUpperCase())) return w.toUpperCase();
  const lower = w.toLowerCase();
  if (!first && SMALL.has(lower)) return lower;
  return lower.replace(/(^|[/-])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

/** "GPS EQUIPPED" to "GPS Equipped"; "Commercial Use - All Dealers" to "Commercial Use". */
export function plainLabel(label: string): string {
  let s = String(label ?? "").replace(/\s+/g, " ").trim().replace(DEALER_SUFFIX, "").trim();
  // Only a name in capitals is recased: one already in mixed case is the provider's own spelling.
  if (/[A-Z]/.test(s) && !/[a-z]/.test(s)) {
    s = s.split(" ").map((w, i) => titleWord(w, i === 0)).join(" ");
  }
  return s;
}

/** A label that would show as the provider keeps it: in capitals, or with a dealer suffix. */
export function labelProblem(label: string): string | null {
  const letters = label.replace(/[^A-Za-z]/g, "");
  const words = label.split(/[\s/-]+/).filter((w) => /[A-Za-z]/.test(w) && !ACRONYMS.has(w.toUpperCase()));
  if (letters.length > 0 && words.length > 0 && words.every((w) => w === w.toUpperCase())) return "in capitals";
  if (DEALER_SUFFIX.test(label) || /\s-\s.*dealers?\s*$/i.test(label)) return "a dealer suffix";
  return null;
}
