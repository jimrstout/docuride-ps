// lib/contract-parties.ts: who goes on the contracts, as the planner sees it.
//
// The panels on Details for the buyer, co-buyer and lienholder. The rules live
// in supabase/functions/_shared/contract-parties.ts; the Next build cannot
// import from there, so the field names and the two sentences staff read are
// mirrored here, and test/contract-parties-ui.test.mjs fails if they drift.
//
// No React and no Next imports, so a Node test can hold it.

/** Every field the panels post, by its fni.sessions column. */
export const PARTY_FIELD_NAMES: readonly string[] = [
  "buyer_type", "buyer_display_name", "buyer_first_name", "buyer_last_name", "buyer_address",
  "buyer_city", "buyer_state", "buyer_zip", "buyer_phone", "buyer_email",
  "cobuyer_type", "cobuyer_display_name", "cobuyer_first_name", "cobuyer_last_name", "cobuyer_address",
  "cobuyer_city", "cobuyer_state", "cobuyer_zip", "cobuyer_phone", "cobuyer_email",
  "lienholder_name", "lienholder_address", "lienholder_city", "lienholder_state", "lienholder_zip",
  "lienholder_phone",
];

export const DX1_REMINDER =
  "This changes what prints on the service contracts. Make the same change in DX1 so the finance contract matches.";

export const DX1_CONFIRMATION = "I have made these changes in DX1, or they are not needed there.";

/** The fields one form posts, read from the form and nothing else. */
export function partyEntries(formData: { get(name: string): unknown }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PARTY_FIELD_NAMES) {
    const v = formData.get(name);
    if (typeof v === "string") out[name] = v;
  }
  return out;
}
