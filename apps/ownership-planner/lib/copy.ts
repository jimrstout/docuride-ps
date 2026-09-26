// Filling a customer-facing sentence, in the browser.
//
// The templates come down with the session, still holding their {placeholder}
// names, because only the planner knows which rate the customer chose and
// therefore what the deductible actually is. The rule is the same one the Edge
// Function applies: a sentence that cannot be completed is dropped, never shown
// with a hole in it.
//
// This mirrors _shared/copy-templates.ts deliberately rather than importing it.
// That module lives in the Deno functions tree, outside this Next app's root,
// and the shared logic here is four lines. The tests on the shared module are
// the record of the behaviour; this is its client-side twin.

const PLACEHOLDER_RE = /\{([a-z0-9_]+)\}/gi;

export const TEMPLATE_DISAPPEARING_DEDUCTIBLE = "deductible.disappearing";

export function renderTemplate(
  body: string | null | undefined,
  values: Record<string, string | null | undefined>
): string | null {
  if (typeof body !== "string" || body.trim() === "") return null;

  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    const v = values[m[1]];
    if (typeof v !== "string" || v.trim() === "") return null;
  }

  return body.replace(PLACEHOLDER_RE, (_w, name: string) => String(values[name]).trim());
}

/**
 * How long a cover lasts, in the words the customer reads.
 *
 * The chosen rate wins over the catalog's static `coverage_duration`, because a
 * customer looking at a 36 / 48 / 60 month choice must not also be reading a
 * fixed "Covers 36 months" that disagrees with the button they just pressed.
 * The catalog line stays as the fallback for a product with a single rate and
 * no term on it.
 *
 * Miles are only ever appended when there are some: every powersports rate we
 * have seen comes back with termMiles 0, and "3 years or 0 miles" is a worse
 * sentence than "3 years".
 */
export function durationOf(
  rate: { term_months: number | null; term_miles: number | null } | undefined,
  fallback: string | null
): string | null {
  if (rate?.term_months) {
    const m = rate.term_months;
    let line = m % 12 === 0 ? `${m / 12} year${m === 12 ? "" : "s"}` : `${m} months`;
    if (rate.term_miles) line += ` or ${rate.term_miles.toLocaleString()} miles`;
    return line;
  }
  return fallback ?? null;
}
