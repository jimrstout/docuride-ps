// Duplicate handling: the same deal twice, the same submit twice, and the same
// machine on two deals.
//
// Two kinds of test here, and the split is deliberate.
//
// The rules themselves live in _shared/duplicates.ts as plain functions, so they
// can be tested directly: what counts as a taken slot, what a lock refuses, what
// an open session is. That is where the behaviour is.
//
// The three Edge Functions that enforce those rules cannot be imported from node
// -- they pull `serve` from deno.land -- so they are checked structurally, by
// reading their source for the specific constructs the rules depend on. It is a
// blunter instrument, and it is still worth having: every one of these assertions
// is a thing that, if it quietly went missing, would produce two live contracts
// or a second planner link for one deal, with nothing else failing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SUBMIT_LOCK_STALE_MS,
  TERMINAL_SESSION_STATUSES,
  blockingByProduct,
  contractsAlreadySubmittedMessage,
  describeContract,
  duplicateVinWarning,
  lockIsStale,
  occupiesSlot,
  sessionIsOpen,
  submitRefusal,
} from "../supabase/functions/_shared/duplicates.ts";

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

const sessionStart = src("../supabase/functions/fni-session-start/index.ts");
const contractSubmit = src("../supabase/functions/fni-contract-submit/index.ts");
const contractVoid = src("../supabase/functions/fni-contract-void/index.ts");
const sessionVerify = src("../supabase/functions/fni-session-verify/index.ts");
const migration = src("../supabase/migrations/0015_duplicate_handling.sql");

const contract = (over = {}) => ({
  provider_product_id: "101",
  contract_number: "TA-900001",
  product_name: "Ownership Plan",
  status: "Live",
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────
// Case 1: the same deal sent from CRM more than once
// ─────────────────────────────────────────────────────────────────────────

test("one session per CRM deal is a database rule, not a code convention", () => {
  // The only guard that holds when two webhooks arrive in the same instant.
  assert.match(
    migration,
    /create unique index[^;]*sessions_one_per_zoho_deal[\s\S]*?on fni\.sessions \(zoho_deal_id\)[\s\S]*?where zoho_deal_id is not null/i
  );
});

test("session start looks the deal up by its CRM id and reuses what it finds", () => {
  assert.match(sessionStart, /\.eq\("zoho_deal_id", zoho_deal_id\)/);
  assert.match(sessionStart, /\.maybeSingle\(\)/);
  assert.match(sessionStart, /return await reopen\(/);
});

test("session start no longer excludes finished sessions from the lookup", () => {
  // The old code skipped Finalized / Written Back / Cancelled sessions, which
  // meant a finished deal coming through again got a SECOND session and a
  // second planner link. Reuse is now unconditional on status.
  assert.doesNotMatch(sessionStart, /terminalStatuses/);
});

test("a reopened session with contracts on it is not touched", () => {
  // The whole point: no reset, no re-rate, no new link. Just the sentence and
  // the numbers. The early return has to come before any update.
  const reopen = sessionStart.slice(sessionStart.indexOf("async function reopen"));
  const said = reopen.indexOf("contractsAlreadySubmittedMessage");
  const patched = reopen.indexOf("crmRatingFields(record");
  assert.ok(said > 0, "reopen must report existing contracts");
  assert.ok(patched > 0, "reopen must otherwise refresh the deal");
  assert.ok(said < patched, "the contracts check must return before anything is written");
  assert.match(reopen, /contracts_submitted: true/);
});

test("a reopened session whose rating inputs moved goes back to Needs Verification", () => {
  const reopen = sessionStart.slice(sessionStart.indexOf("async function reopen"));
  assert.match(reopen, /verification_state: "Needs Verification"/);
  assert.match(reopen, /out_of_date: true/);
});

test("the staff sentence names the live contracts", () => {
  assert.equal(
    contractsAlreadySubmittedMessage([contract(), contract({ provider_product_id: "102", contract_number: "TA-900002" })]),
    "Contracts already submitted on this deal: TA-900001, TA-900002"
  );
});

test("a voided contract is not one that was already submitted", () => {
  assert.equal(
    contractsAlreadySubmittedMessage([contract({ status: "Voided" })]),
    "Contracts already submitted on this deal"
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Case 2: contract submit called more than once
// ─────────────────────────────────────────────────────────────────────────

test("Live and Submit Status Unknown take a product's slot; Voided does not", () => {
  assert.equal(occupiesSlot(contract()), true);
  assert.equal(occupiesSlot(contract({ status: "Submit Status Unknown" })), true);
  assert.equal(occupiesSlot(contract({ status: "Voided" })), false);
});

test("never two live contracts for the same product is a database rule too", () => {
  assert.match(
    migration,
    /create unique index[^;]*agreement_products_one_live_per_product[\s\S]*?\(agreement_id, provider_product_id\)[\s\S]*?where status in \('Live', 'Submit Status Unknown'\)/i
  );
});

test("blockingByProduct keys only the contracts that block", () => {
  const map = blockingByProduct([
    contract({ provider_product_id: "101" }),
    contract({ provider_product_id: "102", status: "Voided" }),
    contract({ provider_product_id: "103", status: "Submit Status Unknown" }),
  ]);
  assert.deepEqual([...map.keys()].sort(), ["101", "103"]);
});

test("a contract of unknown status says so when it is described", () => {
  assert.equal(describeContract(contract()), "Ownership Plan (TA-900001)");
  assert.equal(
    describeContract(contract({ status: "Submit Status Unknown" })),
    "Ownership Plan (TA-900001, submit status unknown)"
  );
  assert.equal(
    describeContract(contract({ product_name: null, contract_number: null })),
    "101 (no contract number recorded)"
  );
});

test("an idle session may submit", () => {
  assert.equal(
    submitRefusal({ submit_state: "Idle", submit_started_at: null, submit_detail: null }),
    null
  );
});

test("a submit in flight is refused as in flight, not as unknown", () => {
  const now = Date.now();
  const refusal = submitRefusal(
    {
      submit_state: "In Progress",
      submit_started_at: new Date(now - 3000).toISOString(),
      submit_detail: null,
    },
    now
  );
  assert.equal(refusal, "A submit is already in progress for this session. Wait for it to finish.");
});

test("a submit that started and never finished is refused as unknown", () => {
  const now = Date.now();
  const started = new Date(now - SUBMIT_LOCK_STALE_MS - 1000).toISOString();
  assert.equal(lockIsStale({ submit_state: "In Progress", submit_started_at: started, submit_detail: null }, now), true);
  assert.match(
    submitRefusal({ submit_state: "In Progress", submit_started_at: started, submit_detail: null }, now),
    /outcome is unknown\. Check in TecAssured before submitting again\./
  );
});

test("a stale lock is never reported as something to wait out", () => {
  // The line that would produce a duplicate: telling somebody to retry a submit
  // whose outcome nobody knows.
  const now = Date.now();
  const started = new Date(now - SUBMIT_LOCK_STALE_MS - 1).toISOString();
  const refusal = submitRefusal(
    { submit_state: "In Progress", submit_started_at: started, submit_detail: null },
    now
  );
  assert.doesNotMatch(refusal, /Wait for it to finish/);
});

test("Submit Status Unknown blocks submitting and carries the detail", () => {
  assert.match(
    submitRefusal({
      submit_state: "Submit Status Unknown",
      submit_started_at: null,
      submit_detail: "connection reset after the provider call",
    }),
    /never learned whether it created contracts[\s\S]*Detail: connection reset after the provider call/
  );
});

test("the lock is taken with a conditional update, which is what makes it a lock", () => {
  // Two requests that both read "Idle" and both write "In Progress" are not
  // locked. The .eq on the OLD value is the whole guard: Postgres applies it
  // atomically, so exactly one gets a row back.
  const lock = contractSubmit.slice(
    contractSubmit.indexOf("const lockToken = crypto.randomUUID()") >= 0
      ? contractSubmit.indexOf("const lockToken = crypto.randomUUID()")
      : contractSubmit.indexOf("lockToken = crypto.randomUUID()")
  );
  assert.match(lock.slice(0, 1200), /submit_state: "In Progress"/);
  assert.match(lock.slice(0, 1200), /\.eq\("submit_state", "Idle"\)/);
  assert.match(lock.slice(0, 2000), /if \(!locked\)/);
});

test("the lock is released only under the token that took it", () => {
  // Otherwise a slow first request releases the second request's lock.
  assert.match(contractSubmit, /submit_state: "Idle"[\s\S]{0,400}\.eq\("submit_token", lockToken\)/);
  assert.match(
    contractSubmit,
    /submit_state: "Submit Status Unknown"[\s\S]{0,300}\.eq\("submit_token", lockToken\)/
  );
});

test("a product that already has a contract is answered, not submitted again", () => {
  assert.match(contractSubmit, /already_submitted: true/);
  assert.match(contractSubmit, /const toSubmit = resolved\.filter\(\(r\) => !alreadyContracted\.has\(r\.providerProductId\)\)/);
});

test("the quote sent to the provider is pruned to the products still needing one", () => {
  // Presence in the quote is what /contract/submit treats as "make me one of
  // these", so leaving an already-contracted product in it asks for a second.
  assert.match(
    contractSubmit,
    /buildSubmitQuote\(\s*offerPayload,\s*toSubmit\.map\(\(r\) => r\.selection\)\s*\)/
  );
});

test("a changed selection is refused until the old contract is voided", () => {
  assert.match(contractSubmit, /must_void_first/);
  assert.match(
    contractSubmit,
    /Void it in TecAssured[\s\S]{0,40}first, then submit again/
  );
  assert.match(
    contractSubmit,
    /There must never be two live contracts for[\s\S]{0,60}the same product on one deal/
  );
});

test("contracts are written as Live, which is what holds the slot", () => {
  assert.match(contractSubmit, /status: "Live",/);
});

test("providerWasCalled is set immediately before the provider call, not after", () => {
  const flag = contractSubmit.indexOf("providerWasCalled = true");
  const call = contractSubmit.indexOf("client.submitContract(");
  assert.ok(flag > 0 && call > 0);
  assert.ok(flag < call, "the flag must be set before the call it is about");
  assert.ok(call - flag < 400, "nothing may come between the flag and the call");
});

test("the catch parks the session at unknown when the provider was called", () => {
  const tail = contractSubmit.slice(contractSubmit.lastIndexOf("} catch (err)"));
  assert.match(tail, /if \(providerWasCalled\)/);
  assert.match(tail, /markUnknown\(/);
  assert.match(tail, /await releaseLock\(\)/);
  assert.doesNotMatch(tail, /retry/i);
});

test("every path that records paperwork badly blocks the next submit", () => {
  // Contracts exist at TecAssured, our rows do not, and the rows are the thing
  // that would have stopped a second contract. So the session is parked rather
  // than released, on all three write failures after the provider call.
  const persistence = contractSubmit.slice(
    contractSubmit.indexOf("Step 7: The agreement"),
    contractSubmit.lastIndexOf("} catch (err)")
  );
  assert.equal((persistence.match(/await markUnknown\(/g) ?? []).length, 3);
  assert.equal((persistence.match(/Do not retry/g) ?? []).length, 3);
});

test("nothing retries a submit automatically", () => {
  assert.doesNotMatch(contractSubmit, /setTimeout|retries\s*=|for \(let attempt/);
});

// ── Getting out of it again ───────────────────────────────────────────────

test("void sends to TecAssured before it marks the row, never the other way", () => {
  const v = contractVoid;
  const provider = v.indexOf("client.voidContract(");
  const marked = v.indexOf('status: "Voided",');
  assert.ok(provider > 0 && marked > 0);
  assert.ok(provider < marked, "freeing the slot before the contract is void invites a duplicate");
});

test("void records who and when", () => {
  assert.match(contractVoid, /voided_at: new Date\(\)\.toISOString\(\)/);
  assert.match(contractVoid, /voided_by: staffEmail/);
  assert.match(contractVoid, /staff_email is required/);
});

test("voiding an already-voided contract is not an error and sends nothing", () => {
  const v = contractVoid;
  const guard = v.indexOf('row.status === "Voided"');
  const provider = v.indexOf("client.voidContract(");
  assert.ok(guard > 0 && guard < provider);
  assert.match(v, /already_voided: true/);
});

test("Submit Status Unknown clears only on a person's word, never a timer", () => {
  assert.match(contractVoid, /Clear Submit Status Unknown/);
  assert.match(contractVoid, /\.eq\("submit_state", "Submit Status Unknown"\)/);
  assert.match(contractVoid, /cleared_by: staffEmail/);
  assert.doesNotMatch(contractVoid, /setTimeout|SUBMIT_LOCK_STALE/);
});

test("void and clear are the only human-readable actions, spelled as words", () => {
  assert.match(contractVoid, /const ACTION_VOID = "Void"/);
  assert.match(contractVoid, /const ACTION_CLEAR = "Clear Submit Status Unknown"/);
  assert.doesNotMatch(contractVoid, /"void"|"clear_unknown"/);
});

// ─────────────────────────────────────────────────────────────────────────
// Case 3: duplicate deals in CRM
// ─────────────────────────────────────────────────────────────────────────

const other = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  deal_number: "14133",
  status: "Rated",
  expires_at: null,
  ...over,
});

test("a finished session is not an open one", () => {
  for (const status of TERMINAL_SESSION_STATUSES) {
    assert.equal(sessionIsOpen(other({ status })), false, status);
  }
  assert.equal(sessionIsOpen(other()), true);
});

test("a lapsed session is not an open one", () => {
  // A stale test session on the same VIN is noise, and a warning nobody needs
  // is a warning everybody learns to ignore.
  const now = Date.parse("2026-09-26T12:00:00Z");
  assert.equal(sessionIsOpen(other({ expires_at: "2026-09-25T12:00:00Z" }), now), false);
  assert.equal(sessionIsOpen(other({ expires_at: "2026-09-27T12:00:00Z" }), now), true);
});

test("the VIN warning is Jim's sentence, with the deal number in it", () => {
  assert.equal(
    duplicateVinWarning([other()]),
    "Another open session exists for this VIN: Deal #14133."
  );
});

test("two others are named, not summarised as a count", () => {
  assert.equal(
    duplicateVinWarning([other(), other({ deal_number: "14140" })]),
    "Other open sessions exist for this VIN: Deal #14133, Deal #14140."
  );
});

test("a session with no deal number still produces a usable warning", () => {
  assert.equal(
    duplicateVinWarning([other({ deal_number: null })]),
    "Another open session exists for this VIN: Deal #number not set."
  );
});

test("no others means no warning at all", () => {
  assert.equal(duplicateVinWarning([]), null);
});

test("the verify sheet looks for other open sessions on the VIN, excluding itself", () => {
  assert.match(sessionVerify, /\.eq\("vin", vin\)/);
  assert.match(sessionVerify, /\.neq\("id", s\.id as string\)/);
  assert.match(sessionVerify, /duplicateVinWarning\(duplicates\)/);
});

test("the VIN warning is scoped to the tenant", () => {
  // Two dealer groups can honestly hold the same VIN, one having sold the
  // machine to the other.
  assert.match(sessionVerify, /q\.eq\("tenant_id", s\.tenant_id\)/);
});

test("the verify sheet surfaces the contracts that block a resubmit", () => {
  assert.match(sessionVerify, /\.filter\(occupiesSlot\)/);
  assert.match(sessionVerify, /submit_state: s\.submit_state \?\? "Idle"/);
});

// ─────────────────────────────────────────────────────────────────────────
// House rules
// ─────────────────────────────────────────────────────────────────────────

test("the new columns use words, not codes", () => {
  assert.match(migration, /check \(status in \('Live', 'Voided', 'Submit Status Unknown'\)\)/);
  assert.match(migration, /check \(submit_state in \('Idle', 'In Progress', 'Submit Status Unknown'\)\)/);
});

test("no em dashes in anything staff or customers read", () => {
  for (const [name, text] of [
    ["duplicates.ts", src("../supabase/functions/_shared/duplicates.ts")],
    ["fni-contract-void", contractVoid],
  ]) {
    // Inside a comment an em dash is a punctuation choice; inside a string it
    // reaches a person. Only strings are checked.
    const strings = text.match(/"(?:[^"\\\n]|\\.)*"/g) ?? [];
    for (const s of strings) {
      assert.ok(!s.includes("—"), `em dash in ${name}: ${s}`);
    }
  }
});
