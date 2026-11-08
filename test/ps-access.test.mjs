// Who sees which stores in the PS admin area (8 Nov 2026, migration 0058):
// an Administrator every store, Staff only the stores granted to them, and
// the sessions list filtered on the server so nothing else is ever sent.
// Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accessFrom, byStoreThenRecent, maySee, NO_STORES_MESSAGE, storeFullName } from "../supabase/functions/_shared/ps-access.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const fn = read("supabase/functions/fni-admin-sessions/index.ts");

const PKB = "11111111-1111-4111-8111-111111111111";
const HTG = "22222222-2222-4222-8222-222222222222";
// Five made-up sessions, as Test holds them: two at Parkersburg, three at Huntington.
const SESSIONS = [
  { deal_number: "15088", store_id: PKB, created_at: "2026-11-06T13:00:00Z" },
  { deal_number: "15010", store_id: PKB, created_at: "2026-11-06T14:00:00Z" },
  { deal_number: "07982", store_id: HTG, created_at: "2026-11-07T00:40:00Z" },
  { deal_number: "07976", store_id: HTG, created_at: "2026-11-07T00:30:00Z" },
  { deal_number: "07888", store_id: HTG, created_at: "2026-11-07T00:20:00Z" },
];
const STORE = { [PKB]: { name: "Parkersburg", zoho_store_location: "All Seasons Powersports, Parkersburg" }, [HTG]: { name: "Huntington", zoho_store_location: "All Seasons Powersports, Barboursville/Huntington" } };
const visible = (access) => SESSIONS.filter((s) => maySee(access, s.store_id)).map((s) => s.deal_number);

test("an Administrator sees all five sessions", () => {
  const admin = accessFrom("Administrator", [], false);
  assert.deepEqual(admin, { role: "Administrator", storeIds: null });
  assert.deepEqual(visible(admin), ["15088", "15010", "07982", "07976", "07888"]);
  // A platform administrator with no PS role yet is one too, so nobody loses the admin area.
  assert.deepEqual(accessFrom(null, [], true), { role: "Administrator", storeIds: null });
});

test("Staff granted only Parkersburg see only 15010 and 15088", () => {
  const staff = accessFrom("Staff", [PKB], false);
  assert.deepEqual(staff, { role: "Staff", storeIds: [PKB] });
  assert.deepEqual(visible(staff).sort(), ["15010", "15088"]);
  // A grant to a store does not leak another.
  assert.equal(maySee(staff, HTG), false);
  assert.equal(maySee(staff, null), false);
});

test("Staff with no stores see none, and are told so; no role, no access", () => {
  const none = accessFrom("Staff", [], false);
  assert.deepEqual(visible(none), []);
  assert.equal(NO_STORES_MESSAGE, "No stores assigned. Ask an administrator for access.");
  assert.equal(accessFrom(null, [PKB], false), null);
  assert.equal(accessFrom("Manager", [PKB], false), null);
});

test("the server reads only the stores the person may see, before anything is sent", () => {
  const list = fn.slice(fn.indexOf("async function list("), fn.indexOf("// ── Administration > Staff"));
  // No stores: nothing is read at all.
  const empty = list.indexOf("if (access.storeIds !== null && access.storeIds.length === 0) {");
  assert.ok(empty > 0);
  assert.match(list.slice(empty, empty + 300), /sessions: \[\] \}\);/);
  // Otherwise the read itself is filtered by store, so no other store's session is ever read.
  assert.match(list, /if \(access\.storeIds !== null\) query = query\.in\("store_id", access\.storeIds\);\s*const \{ data: rows, error \} = await query;/);
  assert.ok(list.indexOf('query = query.in("store_id"') < list.indexOf("await query;"));
  // The other reads hang off the sessions already filtered.
  assert.match(list, /\.in\("session_id", sessionIds\)/);
  // The gate: signed in, with a PS role, before any read.
  const handler = fn.slice(fn.indexOf("serve("));
  assert.ok(handler.indexOf("await psCheck(req)") < handler.indexOf("list(url, gate)"));
  // Staff management is for Administrators only, on read and on write.
  assert.match(handler, /if \(section === "staff"\) \{\s*if \(gate\.access\.role !== "Administrator"\) return json\(403, \{ error: ADMINISTRATORS_ONLY \}\);/);
  assert.match(fn, /async function staffWrite\([^)]*\): Promise<Response> \{\s*if \(gate\.access\.role !== "Administrator"\) return json\(403, \{ error: ADMINISTRATORS_ONLY \}\);/);
});

test("the gate reads role and stores from fni, and writes nothing to public.profiles", () => {
  const gate = read("supabase/functions/_shared/staff-gate.ts");
  const ps = gate.slice(gate.indexOf("export async function psCheck("));
  assert.match(ps, /rest<\{ role: string \}>\(`staff_roles\?user_id=eq\.\$\{staff\.sub\}&select=role`, "fni"\)/);
  assert.match(ps, /rest<\{ store_id: string \}>\(`staff_store_access\?user_id=eq\.\$\{staff\.sub\}&select=store_id`, "fni"\)/);
  for (const rel of ["supabase/functions/_shared/staff-gate.ts", "supabase/functions/fni-admin-sessions/index.ts", "supabase/functions/fni-admin-auth/index.ts"]) {
    assert.doesNotMatch(read(rel), /from\("profiles"\)\.(update|insert|upsert|delete)|profiles\?[^`]*method: "(PATCH|POST|DELETE)"/, rel);
  }
  // Sign-in admits a PS role, as well as the platform administrator flag.
  const auth = read("supabase/functions/fni-admin-auth/index.ts");
  assert.match(auth, /supabase\.schema\("fni"\)\.from\("staff_roles"\)\.select\("role"\)\.eq\("user_id", userId\)\.maybeSingle\(\)/);
  assert.match(auth, /if \(psRole && \["Administrator", "Staff"\]\.includes\(\(psRole as \{ role: string \}\)\.role\)\) \{\s*return json\(200,/);
});

test("the store's full name is the CRM's, and the list comes by store, then most recent", () => {
  assert.equal(storeFullName(STORE[PKB]), "All Seasons Powersports, Parkersburg");
  assert.equal(storeFullName({ name: "Bell Chevrolet", zoho_store_location: null }), "Bell Chevrolet");
  assert.equal(storeFullName({ name: "X", zoho_store_location: "  " }), "X");
  const rows = SESSIONS.map((s) => ({ ...s, store_name: storeFullName(STORE[s.store_id]) }));
  assert.deepEqual(byStoreThenRecent(rows).map((r) => r.deal_number), ["07982", "07976", "07888", "15010", "15088"]);
  assert.match(fn, /select\("id,name,zoho_store_location,time_zone"\)/);
  // The customer's names, and nothing else of theirs.
  assert.match(fn, /"buyer_display_name",\s*"cobuyer_display_name",/);
  assert.doesNotMatch(fn.slice(fn.indexOf("const LIST_COLUMNS"), fn.indexOf("].join")), /buyer_(first|last|address|city|phone|email)|vin|lienholder/);
});
