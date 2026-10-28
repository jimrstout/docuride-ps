// lib/vendor.ts: the contract provider, by the name on its record.
//
// Details used to have provider names written into its labels ("Submit
// contracts to Riders Advantage", "Cancel with TecAssured"). With a second
// provider those read wrong. Every name now comes from the provider record
// (fni.providers.name), which fni-session-verify sends as `provider_name`;
// where there is none, the words say "the provider".
//
// Product names are the provider's own and are shown as they come.
//
// No React and no Next imports, so a Node test can hold it.

/** The contract provider's name, from its record, or "the provider". */
export function vendorName(sheet: {
  provider_name?: string | null;
  contracts_panel?: { provider_name?: string | null } | null;
}): string {
  const name = sheet.provider_name ?? sheet.contracts_panel?.provider_name ?? null;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : "the provider";
}

/** The provider as a sentence starts with it. */
export function sentenceStart(vendor: string): string {
  return vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

/** "the Riders Advantage test server", or "the provider's test server". */
export function testServerName(vendor: string): string {
  return vendor === "the provider" ? "the provider's test server" : `the ${vendor} test server`;
}
