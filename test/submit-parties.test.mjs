// The people on the contract, beyond the documented buyer keys (2026-10-28).
// The field probe found where they print on the Riders Advantage contract
// (docs/multi-provider.md, section 16). Mock data only: every name is invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buyerPhoneKeys, cobuyerKeys } from "../supabase/functions/_shared/submit-parties.ts";
import { applyStaffEdits, parseStaffEdits } from "../supabase/functions/_shared/staff-edits.ts";
import { REMOVED } from "../supabase/functions/_shared/contract-parties.ts";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const DEAL = {
  buyer_type: "Individual", buyer_first_name: "Pat", buyer_last_name: "Sample", buyer_address: "1 Example Road",
  buyer_phone: "304-555-0199",
  cobuyer_type: "Individual", cobuyer_display_name: "Lee Sample", cobuyer_first_name: "Lee", cobuyer_last_name: "Sample",
};
const NO_COBUYER = { ...DEAL, cobuyer_type: null, cobuyer_display_name: null, cobuyer_first_name: null, cobuyer_last_name: null };
const edit = (value, original) =>
  ({ value, original, original_source: "CRM", edited_by: "Sample Staff", edited_at: "2026-10-28T14:00:00Z" });
const party = (row, edits = {}) => applyStaffEdits(row, parseStaffEdits(edits));

test("a co-buyer sends both keys", () => {
  assert.deepEqual(cobuyerKeys(party(DEAL)), { cobuyerFirstName: "Lee", cobuyerLastName: "Sample" });
});

test("no co-buyer sends neither key", () => {
  assert.deepEqual(cobuyerKeys(party(NO_COBUYER)), {});
  // One staff removed is no co-buyer.
  assert.deepEqual(cobuyerKeys(party(DEAL, { cobuyer: edit(REMOVED, null) })), {});
  // Blank text is no co-buyer either.
  assert.deepEqual(cobuyerKeys({ ...NO_COBUYER, cobuyer_first_name: "  ", cobuyer_last_name: "" }), {});
});

test("the staff edit wins over the CRM value", () => {
  const p = party(DEAL, { cobuyer_last_name: edit("Example", "Sample"), cobuyer_first_name: edit("Lea", "Lee") });
  assert.deepEqual(cobuyerKeys(p), { cobuyerFirstName: "Lea", cobuyerLastName: "Example" });
  // A co-buyer added on Details, with none in the CRM.
  const added = party(NO_COBUYER, { cobuyer_first_name: edit("Sam", null), cobuyer_last_name: edit("Sample", null) });
  assert.deepEqual(cobuyerKeys(added), { cobuyerFirstName: "Sam", cobuyerLastName: "Sample" });
});

test("a company co-buyer prints by its business name in cobuyerLastName", () => {
  const co = { ...NO_COBUYER, cobuyer_type: "Company", cobuyer_display_name: "Sample Rentals LLC", cobuyer_first_name: "Lee", cobuyer_last_name: "Sample" };
  assert.deepEqual(cobuyerKeys(party(co)), { cobuyerFirstName: "", cobuyerLastName: "Sample Rentals LLC" });
  // A person with only the name as it prints.
  assert.deepEqual(cobuyerKeys({ ...NO_COBUYER, cobuyer_display_name: "Lee Sample" }), { cobuyerFirstName: "", cobuyerLastName: "Lee Sample" });
});

test("the submit adds them to the quote from the contract parties", () => {
  const submit = src("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /const party = applyStaffEdits\(session as Record<string, unknown>, parseStaffEdits\(session\.staff_edits\)\)[^\n]*\n[\s\S]*?Object\.assign\(submitQuote, cobuyerKeys\(party\)\);/);
  // Added before the dates are aligned and the call is made.
  assert.ok(submit.indexOf("cobuyerKeys(party)") < submit.indexOf("client.submitContractDetailed(submitPayload)"));
});

test("the buyer phone is sent digits only under buyerHomePhone", () => {
  assert.deepEqual(buyerPhoneKeys(party(DEAL)), { buyerHomePhone: "3045550199" });
});

test("phone formatting is stripped", () => {
  for (const v of ["(304) 555-0199", "304.555.0199", "304 555 0199", "+1 304-555-0199", "1-304-555-0199", " 3045550199 "]) {
    assert.deepEqual(buyerPhoneKeys({ buyer_phone: v }), { buyerHomePhone: "3045550199" }, v);
  }
});

test("no phone omits the key", () => {
  for (const v of [null, undefined, "", "   ", "n/a"]) assert.deepEqual(buyerPhoneKeys({ buyer_phone: v }), {}, String(v));
});

test("the staff phone wins over the CRM phone", () => {
  const p = party(DEAL, { buyer_phone: edit("304-555-0177", "304-555-0199") });
  assert.deepEqual(buyerPhoneKeys(p), { buyerHomePhone: "3045550177" });
  const submit = src("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /const party = applyStaffEdits\([^\n]*\n[\s\S]*?Object\.assign\(submitQuote, buyerPhoneKeys\(party\)\);/);
  assert.ok(submit.indexOf("buyerPhoneKeys(party)") < submit.indexOf("client.submitContractDetailed(submitPayload)"));
});
