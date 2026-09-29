// lib/verify-fields.ts — the rating inputs the Verify form may post.
//
// ── The bug this exists to end ────────────────────────────────────────────────
// Save changes used to forward every field in the FormData to the endpoint, on
// the reasoning that the sheet renders an input for exactly the fields the
// endpoint accepts, so the two could not drift. React had other ideas: a Server
// Action form also carries a hidden `$ACTION_ID_<hash>` field of its own. The
// endpoint, correctly, refuses a field it does not recognise -- so the whole
// save came back as
//
//   "These fields cannot be edited here: $ACTION_ID_401dfd..."
//
// and nothing could be saved at all. The framework's own plumbing is not an edit
// to the deal, and a field that is not a rating input must never be able to
// refuse a save.
//
// So the action reads the known names and ignores everything else, rather than
// forwarding everything and hoping. That also holds if React adds another hidden
// field tomorrow.
//
// Kept in step with EDIT_TARGETS in supabase/functions/_shared/staff-edits.ts by
// test/verify-fields-parity.test.mjs, the same way lib/money.ts is kept in step
// with _shared/money.ts. The Next build cannot import from the Deno side, so a
// test is what stops the two lists drifting.

/**
 * Every field key the Verify sheet can render an input for.
 *
 * Not every one is editable on every deal -- the three finance figures close on
 * a cash deal -- but a key absent from this list is not a rating input at all.
 * The endpoint still decides what it will accept; this only decides what is
 * worth sending it.
 */
export const RATING_INPUT_NAMES: readonly string[] = [
  // Deal
  "deal_type",
  "sale_date",
  // Vehicle
  "vin",
  "unit_year",
  "unit_make",
  "unit_model",
  "condition",
  "vehicle_type_code",
  "odometer",
  "in_service_date",
  "engine.ccs",
  "warranty",
  "fuel.type",
  // Money
  "sale_price",
  "amount_financed",
  "finance_term",
  "apr",
  // Customer
  "buyer_city",
  "buyer_state",
  "buyer_zip",
];

const NAMES = new Set(RATING_INPUT_NAMES);

/**
 * The only values fuel type may be saved as. The Verify sheet offers exactly
 * these in a dropdown, and _shared/fuel-type.ts FUEL_TYPES is the same list:
 * test/fuel-type.test.mjs keeps the two in step.
 */
export const FUEL_TYPE_CHOICES: readonly string[] = ["Gasoline", "Electric", "Diesel"];

/**
 * Is this form field an edit to the deal?
 *
 * The `$` test is redundant given the allow-list and is kept anyway, because it
 * is the rule that was actually violated and it costs nothing to state twice.
 */
export function isRatingInputName(name: string): boolean {
  if (name.startsWith("$")) return false;
  return NAMES.has(name);
}

/** The edits in a submitted Verify form, and nothing else that came with them. */
export function ratingInputsFrom(
  entries: Iterable<[string, FormDataEntryValue]>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== "string") continue;
    if (!isRatingInputName(key)) continue;
    // Fuel type is one of three words or nothing. Anything else did not come
    // from the dropdown and is not forwarded.
    if (key === "fuel.type" && value !== "" && !FUEL_TYPE_CHOICES.includes(value)) continue;
    // A blank box is sent through on purpose: that is how a person puts the
    // original CRM value back.
    out[key] = value;
  }
  return out;
}
