// A session whose every contract is voided reopens (2026-10-28). Getting the
// documents moved it to Finalized and voiding never moved it back, so Submit
// refused "Session is Finalized." with nothing live. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REOPENED_EVENT,
  REOPENED_STATUS,
  reopenIfAllVoided,
  shouldReopen,
} from "../supabase/functions/_shared/session-reopen.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const V = { status: "Voided" };
const L = { status: "Live" };
const U = { status: "Submit Status Unknown" };

/**
 * A stand-in for supabase-js: answers reads from `db`, records every write,
 * and applies the session update's conditions the way Postgres would.
 */
function fakeSupabase(db) {
  const writes = [];
  const client = {
    schema: () => client,
    from(table) {
      const q = { table, op: "select", filters: [], patch: null, row: null };
      const b = {
        select() { return b; },
        eq(col, val) { q.filters.push(["eq", col, val]); return b; },
        in(col, vals) { q.filters.push(["in", col, vals]); return b; },
        update(patch) { q.op = "update"; q.patch = patch; return b; },
        insert(row) { q.op = "insert"; q.row = row; writes.push({ table, op: "insert", row }); return Promise.resolve({ error: null }); },
        maybeSingle() { return Promise.resolve(run(q)); },
        then(res, rej) { return Promise.resolve(run(q)).then(res, rej); },
      };
      return b;
    },
  };
  const matches = (row, filters) =>
    filters.every(([kind, col, val]) => (kind === "eq" ? row[col] === val : val.includes(row[col])));
  function run(q) {
    // A copy, as supabase-js returns: a later write must not change what was read.
    if (q.table === "sessions" && q.op === "select") return { data: { ...db.session }, error: null };
    if (q.table === "agreements") return { data: db.agreements, error: null };
    if (q.table === "agreement_products") return { data: db.contracts, error: null };
    if (q.table === "sessions" && q.op === "update") {
      writes.push({ table: "sessions", op: "update", patch: q.patch });
      const row = { id: "s1", ...db.session };
      if (!matches(row, q.filters)) return { data: null, error: null };
      Object.assign(db.session, q.patch);
      return { data: { id: "s1" }, error: null };
    }
    return { data: null, error: null };
  }
  return { client, writes, db };
}

const deal = (status, contracts, submit_state = "Idle") =>
  fakeSupabase({ session: { status, submit_state }, agreements: [{ id: "a1" }], contracts });

test("the last void reopens the session to Products Selected", async () => {
  assert.equal(shouldReopen("Finalized", "Idle", [V]), true);
  assert.equal(shouldReopen("Agreement Created", "Idle", [V, V]), true);
  const f = deal("Finalized", [V, V]);
  assert.equal(await reopenIfAllVoided(f.client, "s1", "JS"), true);
  assert.equal(f.db.session.status, REOPENED_STATUS);
  assert.equal(REOPENED_STATUS, "Products Selected");
});

test("a void that leaves another live contract leaves the status alone", async () => {
  assert.equal(shouldReopen("Finalized", "Idle", [V, L]), false);
  assert.equal(shouldReopen("Finalized", "Idle", [V, U]), false);
  for (const contracts of [[V, L], [V, U]]) {
    const f = deal("Finalized", contracts);
    assert.equal(await reopenIfAllVoided(f.client, "s1", "JS"), false);
    assert.equal(f.db.session.status, "Finalized");
    assert.deepEqual(f.writes, []);
  }
});

test("a session mid-submit, with no contracts, or not in a submitted status is left alone", async () => {
  assert.equal(shouldReopen("Finalized", "In Progress", [V]), false);
  assert.equal(shouldReopen("Finalized", "Submit Status Unknown", [V]), false);
  assert.equal(shouldReopen("Finalized", "Idle", []), false);
  for (const s of ["Products Selected", "Written Back", "Cancelled", "Rated"]) assert.equal(shouldReopen(s, "Idle", [V]), false, s);
  // The update itself re-checks, so a submit that started in between is never overwritten.
  const raced = fakeSupabase({ session: { status: "Finalized", submit_state: "Idle" }, agreements: [{ id: "a1" }], contracts: [V] });
  const origFrom = raced.client.from.bind(raced.client);
  let reads = 0;
  raced.client.from = (t) => { if (t === "sessions" && ++reads === 2) raced.db.session.submit_state = "In Progress"; return origFrom(t); };
  assert.equal(await reopenIfAllVoided(raced.client, "s1", "JS"), false);
  assert.equal(raced.db.session.status, "Finalized");
});

test("only the status changes: selections, offers, verification, dates and prices are untouched", async () => {
  const f = deal("Finalized", [V]);
  await reopenIfAllVoided(f.client, "s1", "JS");
  const tables = f.writes.map((w) => `${w.table}.${w.op}`);
  assert.deepEqual(tables, ["sessions.update", "session_events.insert"]);
  assert.deepEqual(f.writes[0].patch, { status: "Products Selected" });
  const src = read("supabase/functions/_shared/session-reopen.ts");
  assert.doesNotMatch(src, /selected_products|rated_offers|verification_state|sale_date|_price/);
});

test("the event names the signed-in person's initials, or System", async () => {
  const signedIn = deal("Finalized", [V]);
  await reopenIfAllVoided(signedIn.client, "s1", "JS");
  const e = signedIn.writes.find((w) => w.table === "session_events").row;
  assert.equal(e.event, "Session reopened: all contracts voided");
  assert.equal(e.event, REOPENED_EVENT);
  assert.equal(e.created_by, "JS");
  assert.deepEqual(e.detail, { from: "Finalized", to: "Products Selected" });
  const nobody = deal("Finalized", [V]);
  await reopenIfAllVoided(nobody.client, "s1", undefined);
  assert.equal(nobody.writes.find((w) => w.table === "session_events").row.created_by, "System");
});

test("both voids reopen after the contract is recorded as voided, with the person's initials", () => {
  const v = read("supabase/functions/fni-contract-void/index.ts");
  assert.equal((v.match(/await reopenIfAllVoided\(supabase, session_id, body\.staff_initials\)/g) ?? []).length, 2);
  assert.ok(v.indexOf('status: "Voided",\n        voided_at') < v.lastIndexOf("await reopenIfAllVoided("));
  const oem = read("supabase/functions/fni-oem-contracts/index.ts");
  assert.match(oem, /\.eq\("status", "Live"\);\s*if \(error\) return json\(500[^\n]*\n\s*\/\/[^\n]*\n\s*const reopened = await reopenIfAllVoided\(supabase, sessionId, body\.staff_initials\);/);
  const actions = read("apps/ownership-planner/app/console-actions.ts");
  assert.equal((actions.match(/staff_initials: initialsFor\(operator\.email\),/g) ?? []).length, 2);
});

test("the contract panels unlock by the rule they already use", () => {
  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /return \(\(data \?\? \[\]\) as ContractRef\[\]\)\.filter\(occupiesSlot\);/);
  assert.match(verify, /contract_parties: contractParties\(s, edits, contracts\.length > 0\),/);
  assert.match(read("supabase/functions/_shared/session-reopen.ts"), /import \{ occupiesSlot, type ContractRef \} from "\.\/duplicates\.ts";/);
});
