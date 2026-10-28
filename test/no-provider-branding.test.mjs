// No provider branding on Details or in the submit flow (2026-10-28).
//
// "Submit contracts to Riders Advantage" is now "Submit contracts", and no
// label, button or message on Details, its components or the submit flow has
// a provider's name written in. Where a name is needed it comes from the
// provider record (fni.providers.name), so another provider reads correctly.
// Product names are the provider's own and come through as they are.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sentenceStart, testServerName, vendorName } from "../apps/ownership-planner/lib/vendor.ts";
import { readSubmitResponse } from "../supabase/functions/_shared/submit-outcome.ts";
import { submitRefusal } from "../supabase/functions/_shared/duplicates.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

/** Every file swept: Details, the components it draws, and the submit flow. */
const SWEPT = [
  "apps/ownership-planner/app/details/[sessionId]/page.tsx",
  "apps/ownership-planner/components/ContractParties.tsx",
  "apps/ownership-planner/components/VehicleTypeChoice.tsx",
  "apps/ownership-planner/components/OemContractRecord.tsx",
  "apps/ownership-planner/components/VerifySidebarFields.tsx",
  "apps/ownership-planner/components/PendingButton.tsx",
  "apps/ownership-planner/components/Working.tsx",
  "apps/ownership-planner/components/LongText.tsx",
  "apps/ownership-planner/components/RatingErrorText.tsx",
  "apps/ownership-planner/components/HomeLink.tsx",
  "apps/ownership-planner/components/admin/ProgramLabel.tsx",
  "apps/ownership-planner/app/console-actions.ts",
  "apps/ownership-planner/lib/verify-flash.ts",
  "apps/ownership-planner/lib/submit-check.ts",
  "apps/ownership-planner/lib/vendor.ts",
  "supabase/functions/fni-contract-submit/index.ts",
  "supabase/functions/_shared/submit-outcome.ts",
  "supabase/functions/_shared/price-cap.ts",
  "supabase/functions/_shared/duplicates.ts",
  "supabase/functions/_shared/contract-guard.ts",
  "supabase/functions/_shared/sale-date.ts",
];

/** The source with comments taken out: what can reach a screen. */
function code(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every string literal and JSX text run that names a provider. */
function brandedText(src) {
  const c = code(src);
  const hits = [];
  // Quoted strings. "TecAssured" alone is the adapter's stored value, compared
  // in code (adapter === "TecAssured"), and never shown.
  for (const m of c.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
    const s = m[1] ?? m[2] ?? m[3] ?? "";
    if (s === "TecAssured") continue;
    if (/TecAssured|Riders Advantage/.test(s)) hits.push(s);
  }
  // JSX text between tags.
  for (const m of c.matchAll(/>([^<>{}]*)</g)) {
    if (/TecAssured|Riders Advantage/.test(m[1])) hits.push(m[1].trim());
  }
  return hits;
}

test("the submit button says Submit contracts, with no provider name", () => {
  const page = read("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(page, />\s*Submit contracts\s*</);
  assert.doesNotMatch(page, /Submit contracts to/);
});

test("no provider name is written into a label, button or message in the swept files", () => {
  for (const f of SWEPT) assert.deepEqual(brandedText(read(f)), [], f);
  // The check itself finds what it is looking for.
  assert.deepEqual(brandedText('<b>Cancel with TecAssured</b>; x = "Submit to Riders Advantage";'), [
    "Submit to Riders Advantage",
    "Cancel with TecAssured",
  ]);
  assert.deepEqual(brandedText('// Riders Advantage\nif (p.adapter === "TecAssured") {}'), []);
});

test("the name comes from the provider record, and reads as the provider without one", () => {
  assert.equal(vendorName({ provider_name: "Sample Provider" }), "Sample Provider");
  assert.equal(vendorName({ provider_name: null, contracts_panel: { provider_name: "Other Provider" } }), "Other Provider");
  assert.equal(vendorName({}), "the provider");
  assert.equal(sentenceStart("the provider"), "The provider");
  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /const providerName = await tecAssuredProviderName\(supabase, s\.tenant_id\)/);
  assert.match(verify, /provider_name: providerName,/);
  const rows = read("supabase/functions/_shared/provider-rows.ts");
  assert.match(rows, /\.from\("providers"\)\s*\.select\("name"\)\s*\.eq\("tenant_id", tenantId\)\s*\.eq\("adapter", "TecAssured"\)/);
  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /vendor = \(await tecAssuredProviderName\(supabase, session\.tenant_id\)/);
  assert.match(submit, /vendor = ratedOffer\.provider\?\.name \?\? vendor;/);
  assert.match(submit, /provider_name: vendor,/);
});

test("the test session banner names the provider's test server from the record", () => {
  assert.equal(testServerName("Sample Provider"), "the Sample Provider test server");
  assert.equal(testServerName("the provider"), "the provider's test server");
  const page = read("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(page, /This is a test session\. Its contracts go only to \{testServerName\(vendor\)\}/);
  assert.match(page, /const vendor = vendorName\(sheet\);/);
});

test("submit messages name whichever provider the contracts went to", () => {
  const asked = [{ rateUniqueId: "r1", productName: "Sample Product" }];
  const r = readSubmitResponse({ contracts: [{ rateUniqueId: "r1", contractNumber: "C-1" }] }, asked, "Other Provider");
  assert.match(r.message, /^Submitted\. Other Provider created 1 contract\./);
  assert.match(
    submitRefusal({ submit_state: "Submit Status Unknown", submit_started_at: null, submit_detail: null }, Date.now(), "Other Provider"),
    /reached Other Provider and we never learned whether it created contracts\. Check with Other Provider/
  );
  const actions = read("apps/ownership-planner/app/console-actions.ts");
  assert.match(actions, /`Submitted\. \$\{providerSays\(done\.provider_name\)\} returned/);
});

test("a product name from the provider is shown as it comes", () => {
  const page = read("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(page, /<strong>\{c\.product_name\}<\/strong>/);
});
