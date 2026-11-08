// Stores in PS (9 Nov 2026, migration 0059): the CRM's full store name
// everywhere, PS turned on or off per store, and each store's time zone kept
// in fni.ps_stores. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { storeFullName } from "../supabase/functions/_shared/ps-access.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const functions = (() => {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) out.push(p.slice(ROOT.length)); } };
  walk(join(ROOT, "supabase/functions"));
  return out;
})();

// ── 3. Full store names everywhere ──────────────────────────────────────────
test("every store name PS sends is the CRM's full name, from one function", () => {
  for (const rel of functions) {
    const src = read(rel);
    for (const m of src.matchAll(/\.from\("stores"\)\s*\.select\("([^"]*)"\)/g)) {
      const cols = m[1].split(",").map((c) => c.trim());
      if (!cols.includes("name")) continue;
      // A read that takes the name also takes the full name, and the file shows it through storeFullName.
      assert.ok(cols.includes("zoho_store_location"), `${rel}: ${m[1]}`);
      assert.match(src, /storeFullName\(/, rel);
    }
  }
  assert.equal(storeFullName({ name: "Huntington", zoho_store_location: "All Seasons Powersports, Barboursville/Huntington" }), "All Seasons Powersports, Barboursville/Huntington");
});

test("the Sessions list, its store choice and the Staff page take names from the same rows and function", () => {
  const fn = read("supabase/functions/fni-admin-sessions/index.ts");
  // The store choice (stores) and each row (store_name) both come from storeFullName on the same public.stores read.
  assert.match(fn, /const storeList = permitted\.map\(\(s\) => \(\{ id: s\.id, name: storeFullName\(s\) \}\)\);/);
  assert.match(fn, /names\.set\(id, storeFullName\(s\)\);/);
  assert.match(fn, /stores: \(\(stores \?\? \[\]\) as StoreRow\[\]\)[\s\S]*?storeFullName\(s\)/);
});

test("a store without a CRM name shows its own name, never blank", () => {
  assert.equal(storeFullName({ name: "Bell Chevrolet", zoho_store_location: null }), "Bell Chevrolet");
  assert.equal(storeFullName({ name: "X", zoho_store_location: "  " }), "X");
});

// ── 4. DocuRide PS turned on or off per store ───────────────────────────────
test("session start refuses a store that is off, after reopening an existing session and before any insert", () => {
  const src = read("supabase/functions/fni-session-start/index.ts");
  const check = src.indexOf("await usesPs(supabase, storeRow.id)");
  assert.ok(check > 0, "usesPs check present");
  assert.match(src.slice(check, check + 200), /json\(403, \{ error: PS_NOT_ON \}\)/);
  const reopen = src.search(/existing/i);
  const insert = src.indexOf('.from("sessions").insert');
  assert.ok(reopen > 0 && reopen < check, "an existing session reopens first, whatever the switch says");
  assert.ok(insert === -1 || check < insert, "the check comes before a new session is written");
  assert.equal(read("supabase/functions/_shared/ps-stores.ts").match(/PS_NOT_ON = "([^"]+)"/)[1], "DocuRide PS isn't turned on for this store.");
});

test("the Sessions store choice and the Staff page offer only stores that are on; an Administrator still sees every session", () => {
  const src = read("supabase/functions/fni-admin-sessions/index.ts");
  assert.match(src, /async function storesUsingPs/);
  assert.match(src, /access\.storeIds === null \? access : \{ \.\.\.access, storeIds: access\.storeIds\.filter\(\(id\) => on\.has\(id\)\) \}/);
  assert.match(src, /const access = effectiveAccess\(gate\.access, on\);/);
  assert.match(src, /permittedStores\(supabase, gate\.access, await storesUsingPs\(supabase\)\)/);
  assert.match(src, /\.filter\(\(s\) => on\.has\(s\.id\)\)\.map\(\(s\) => \(\{ id: s\.id, name: storeFullName\(s\) \}\)\)/);
});

test("the switch saves to fni.ps_stores with who changed it, only for a store of the dealer group", () => {
  const src = read("supabase/functions/fni-admin-settings/stores.ts");
  const at = src.indexOf('typeof body.uses_ps === "boolean"');
  assert.ok(at > 0);
  const block = src.slice(at, at + 1200);
  assert.match(block, /\.eq\("tenant_id", tenantId\)/);
  assert.match(block, /schema\("fni"\)\.from\("ps_stores"\)\.upsert\(\s*\{ store_id: body\.store_id, uses_ps: body\.uses_ps, updated_at: [^,]+, updated_by: who \|\| null \}/);
  assert.doesNotMatch(src, /\.from\("stores"\)\.(update|upsert|insert)/, "public.stores is never written");
  assert.match(src, /same_dealer: sameDealer\(s\)/);
});

test("the Stores page lists stores that are on by default, with Show all stores and the shared-dealer note", () => {
  const src = read("apps/ownership-planner/app/admin/stores/page.tsx");
  assert.match(src, /const shown = showingAll \? payload\.stores : payload\.stores\.filter\(\(s\) => s\.uses_ps\);/);
  assert.match(src, /Show all stores \(\$\{payload\.stores\.length\}\)/);
  assert.match(src, /Same dealer as \{other\}/);
  assert.match(src, /<UsesPsSwitch /);
  assert.doesNotMatch(src, /—/, "no em dashes");
});
