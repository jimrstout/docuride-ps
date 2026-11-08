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
