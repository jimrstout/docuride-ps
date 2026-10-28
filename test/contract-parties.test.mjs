// Who goes on the contracts (2026-10-28): the buyer, co-buyer and lienholder,
// shown and edited on Details, kept as staff edits over the CRM's values, sent
// on contracts, confirmed against DX1 at Submit, and locked while a contract is
// live. Mock data only: every name and address here is invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  contractParties,
  DX1_CONFIRMATION,
  LOCK_REASON,
  partyChanges,
  partyValue,
  PARTY_FIELDS,
  REMOVED,
} from "../supabase/functions/_shared/contract-parties.ts";
import { applyStaffEdits, parseStaffEdits } from "../supabase/functions/_shared/staff-edits.ts";
import { editFor } from "../supabase/functions/fni-session-verify/save-edits.ts";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const DEAL = {
  buyer_type: "Individual", buyer_display_name: "Pat Sample", buyer_first_name: "Pat", buyer_last_name: "Smaple",
  buyer_address: "1 Example Road", buyer_city: "Sampleton", buyer_state: "WV", buyer_zip: "26000",
  buyer_phone: "304-555-0199", buyer_email: "pat@example.com",
  cobuyer_type: "Individual", cobuyer_display_name: "Lee Sample", cobuyer_first_name: "Lee", cobuyer_last_name: "Sample",
  cobuyer_address: "1 Example Road", cobuyer_city: "Sampleton", cobuyer_state: "WV", cobuyer_zip: "26000",
  cobuyer_phone: null, cobuyer_email: null,
  lienholder_name: "Sample Credit Union", lienholder_address: "9 Lender Way", lienholder_city: "Example City",
  lienholder_state: "WV", lienholder_zip: "26001", lienholder_phone: "304-555-0188",
};
const CASH = Object.fromEntries(Object.entries(DEAL).map(([k, v]) => [k, k.startsWith("cobuyer_") || k.startsWith("lienholder_") ? null : v]));
const spec = (key) => PARTY_FIELDS.find((f) => f.key === key);
const edit = (value, original, at = "2026-10-28T14:00:00Z") =>
  ({ value, original, original_source: original === null ? "Missing" : "CRM", edited_by: "Sample Staff", edited_at: at });

test("three panels show every stored field, in plain English", () => {
  const c = contractParties(DEAL, {}, false);
  assert.deepEqual(c.parties.map((p) => p.party), ["Buyer", "Co-buyer", "Lienholder"]);
  assert.ok(c.parties.every((p) => p.present));
  assert.deepEqual(c.parties[0].fields.map((f) => f.label), [
    "Type", "Name as it prints", "First name", "Last name", "Street address", "City", "State", "ZIP", "Phone", "Email",
  ]);
  assert.deepEqual(c.parties[2].fields.map((f) => f.label), ["Name", "Street address", "City", "State", "ZIP", "Phone"]);
  assert.equal(c.parties[0].heading, "Pat Smaple");
  assert.equal(c.parties[2].heading, "Sample Credit Union");
  assert.equal(c.locked, false);
  assert.deepEqual(c.changes, []);
});

test("a cash deal has no lienholder and no co-buyer", () => {
  const c = contractParties(CASH, {}, false);
  assert.equal(c.parties[1].present, false);
  assert.equal(c.parties[2].present, false);
  assert.equal(c.parties[2].in_crm, false);
  assert.deepEqual(c.parties[2].missing, []);
});

test("a business buyer leads with the business name", () => {
  const c = contractParties({ ...CASH, buyer_type: "Company", buyer_display_name: "Sample Rentals LLC", buyer_first_name: null, buyer_last_name: null }, {}, false);
  assert.equal(c.parties[0].business, true);
  assert.equal(c.parties[0].heading, "Sample Rentals LLC");
  assert.deepEqual(c.parties[0].missing, []);
});

test("missing pieces the contracts need are named in plain English", () => {
  const c = contractParties({ ...DEAL, buyer_last_name: null, lienholder_address: "  " }, {}, false);
  assert.deepEqual(c.parties[0].missing, ["Missing: buyer last name"]);
  assert.deepEqual(c.parties[2].missing, ["Missing: lienholder street address"]);
  const biz = contractParties({ ...CASH, buyer_type: "Company", buyer_display_name: null }, {}, false);
  assert.deepEqual(biz.parties[0].missing, ["Missing: buyer business name"]);
});

test("an edit is recorded with who, when, the old value and the new value", () => {
  const e = editFor({ kind: "column", column: "buyer_last_name", cast: "text" }, "Sample", { value: "Smaple", source: "CRM" }, undefined, "Sample Staff", "2026-10-28T14:00:00Z");
  assert.deepEqual(e, { value: "Sample", original: "Smaple", original_source: "CRM", edited_by: "Sample Staff", edited_at: "2026-10-28T14:00:00Z" });
  // The same value as the CRM is no edit at all.
  assert.equal(editFor({ kind: "column", column: "buyer_last_name", cast: "text" }, "Smaple", { value: "Smaple", source: "CRM" }, undefined, "x", "t"), null);
  const c = contractParties(DEAL, { buyer_last_name: e }, false);
  const f = c.parties[0].fields.find((x) => x.key === "buyer_last_name");
  assert.equal(f.value, "Sample");
  assert.equal(f.was, "Smaple");
  assert.equal(f.edited_by, "Sample Staff");
  assert.equal(f.crm_changed, false);
  assert.deepEqual(c.changes, [{ key: "buyer_last_name", party: "Buyer", label: "Buyer last name", was: "Smaple", now: "Sample" }]);
});

test("Refresh from CRM keeps the staff value, and a later CRM change is shown beside it", () => {
  const edits = { buyer_last_name: edit("Sample", "Smaple") };
  // The CRM row after a refresh: the deal now says something else again.
  const refreshed = { ...DEAL, buyer_last_name: "Samples" };
  assert.equal(applyStaffEdits(refreshed, edits).buyer_last_name, "Sample");
  const f = contractParties(refreshed, edits, false).parties[0].fields.find((x) => x.key === "buyer_last_name");
  assert.equal(f.value, "Sample");
  assert.equal(f.crm_value, "Samples");
  assert.equal(f.crm_changed, true);
  // The CRM catching up to the staff value is not a difference.
  const caught = contractParties({ ...DEAL, buyer_last_name: "Sample" }, edits, false).parties[0].fields.find((x) => x.key === "buyer_last_name");
  assert.equal(caught.crm_changed, false);
  // The CRM still saying what it said when the edit was made is not one either.
  const same = contractParties(DEAL, edits, false).parties[0].fields.find((x) => x.key === "buyer_last_name");
  assert.equal(same.crm_changed, false);
});

test("submit sends the staff values, and nothing for a removed lienholder", () => {
  const edits = parseStaffEdits({ buyer_first_name: edit("Patricia", "Pat"), lienholder_name: edit("Sample Federal Credit Union", "Sample Credit Union") });
  const row = applyStaffEdits(DEAL, edits);
  assert.equal(row.buyer_first_name, "Patricia");
  assert.equal(row.lienholder_name, "Sample Federal Credit Union");
  const removed = applyStaffEdits(DEAL, parseStaffEdits({ lienholder: edit(REMOVED, null) }));
  assert.equal(removed.lienholder_name, null);
  assert.equal(removed.lienholder_zip, null);
  assert.equal(removed.buyer_last_name, "Smaple");
});

test("removing and adding: a removal is an edit, listed as a change", () => {
  const c = contractParties(DEAL, { cobuyer: edit(REMOVED, null) }, false);
  assert.equal(c.parties[1].present, false);
  assert.equal(c.parties[1].in_crm, true);
  assert.deepEqual(c.parties[1].removed, { by: "Sample Staff", at: "2026-10-28T14:00:00Z" });
  assert.equal(c.changes[0].label, "Co-buyer removed");
  // A co-buyer added on a deal the CRM has none for.
  const added = contractParties(CASH, { cobuyer_first_name: edit("Lee", null), cobuyer_last_name: edit("Sample", null) }, false);
  assert.equal(added.parties[1].present, true);
  assert.equal(added.parties[1].heading, "Lee Sample");
});

test("typed values are checked and stored as people read them", () => {
  assert.deepEqual(partyValue(spec("buyer_state"), "wv"), { value: "WV" });
  assert.match(partyValue(spec("buyer_state"), "West Virginia").problem, /Buyer state must be two letters/);
  assert.deepEqual(partyValue(spec("lienholder_zip"), "26001-1234"), { value: "26001-1234" });
  assert.match(partyValue(spec("lienholder_zip"), "2600").problem, /Lienholder zip must be five digits/);
  assert.deepEqual(partyValue(spec("buyer_phone"), "(304) 555-0199"), { value: "(304) 555-0199" });
  assert.match(partyValue(spec("buyer_phone"), "555-0199").problem, /ten-digit/);
  assert.match(partyValue(spec("buyer_email"), "pat at example").problem, /not an email/);
  assert.deepEqual(partyValue(spec("cobuyer_type"), "company"), { value: "Company" });
});

test("the Submit confirmation is needed only when something was changed", () => {
  assert.deepEqual(partyChanges(DEAL, {}), []);
  assert.equal(partyChanges(DEAL, { buyer_zip: edit("26002", "26000") }).length, 1);
  // A rating-only edit is not a contract detail.
  assert.deepEqual(partyChanges(DEAL, { odometer: edit("12", "10") }), []);
  assert.equal(DX1_CONFIRMATION, "I have made these changes in DX1, or they are not needed there.");
});

test("locked while a contract is live, unlocked once every live contract is voided", () => {
  const live = contractParties(DEAL, {}, true);
  assert.equal(live.locked, true);
  assert.equal(live.lock_reason, LOCK_REASON);
  assert.equal(contractParties(DEAL, {}, false).locked, false);
});

test("fni-session-verify locks the panels and refuses edits while a contract is live", () => {
  const v = src("supabase/functions/fni-session-verify/index.ts");
  // The lock is the live-contract list: Live or Submit Status Unknown (duplicates.ts).
  assert.match(v, /contract_parties: contractParties\(s, edits, contracts\.length > 0\),/);
  assert.match(v, /if \(\(await liveContracts\(supabase, s\.id as string\)\)\.length > 0\) \{\s*return json\(409, \{ error: LOCK_REASON \}\);/);
  assert.match(v, /if \(key && isPartyKey\(key\) && \(await liveContracts\(supabase, s\.id as string\)\)\.length > 0\) \{/);
});
