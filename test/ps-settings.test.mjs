// PS-wide settings live in fni.ps_settings (migration 0057), never on the
// shared company record. public.tenants is referenced by R&R reporting,
// DocuRide DC, the Zoho mirror and more, so PS reads it (the tenant's id and
// name) but writes nothing to it. The one exception is company
// administration in orgs.html, which edits the company record itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ── Both settings are saved to and read from fni.ps_settings ────────────────
test("the default deductible is upserted into fni.ps_settings and read from there", () => {
  const save = read("supabase/functions/fni-admin-settings/templates.ts");
  assert.match(save, /\.schema\("fni"\)\.from\("ps_settings"\)\.upsert\(\s*\{ tenant_id: tenantId, default_deductible: value, updated_at: new Date\(\)\.toISOString\(\), updated_by: by \},\s*\{ onConflict: "tenant_id" \},\s*\);/);
  assert.match(read("supabase/functions/_shared/default-deductible.ts"), /\.schema\("fni"\)\.from\("ps_settings"\)\.select\("default_deductible"\)\.eq\("tenant_id", tenantId\)/);
});

test("the dealer group name is upserted into fni.ps_settings, and the Wording screen and the storyboard read it from there", () => {
  const fn = read("supabase/functions/fni-admin-settings/index.ts");
  assert.match(fn, /\.schema\("fni"\)\s*\.from\("ps_settings"\)\s*\.upsert\(\s*\{ tenant_id: tenant\.id, dealer_group_display_name: name, updated_at: new Date\(\)\.toISOString\(\), updated_by: who \},\s*\{ onConflict: "tenant_id" \}\s*\);/);
  assert.match(fn, /\.schema\("fni"\)\s*\.from\("ps_settings"\)\s*\.select\("dealer_group_display_name"\)\s*\.eq\("tenant_id", rows\[0\]\.id\)/);
  assert.match(fn, /\.from\("tenants"\)\s*\.select\("id, name"\)\s*\.eq\("crm_sync", "zoho"\);/);
  const get = read("supabase/functions/fni-session-get/index.ts");
  assert.match(get, /\.schema\("fni"\)\s*\.from\("ps_settings"\)\s*\.select\("dealer_group_display_name"\)\s*\.eq\("tenant_id", s\.tenant_id as string\)/);
  assert.match(read("apps/ownership-planner/app/console-actions.ts"), /dealer_group_display_name: name,\s*updated_by: operator\.email,/);
  // Nothing in PS reads either setting from public.tenants any more.
  for (const rel of ["supabase/functions/fni-admin-settings/index.ts", "supabase/functions/fni-session-get/index.ts"]) {
    assert.doesNotMatch(read(rel), /from\("tenants"\)[^;]*dealer_group_display_name/, rel);
  }
});

// ── PS writes nothing to public.tenants ─────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vercel", "test"]);
const CODE = /\.(ts|tsx|js|mjs|cjs|html|sql)$/;
/** Company administration: it edits the company record itself. */
const ALLOWED = new Set(["orgs.html"]);

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (CODE.test(name)) out.push(relative(ROOT, path));
  }
  return out;
}

/** Each write to public.tenants in a file's text, in plain words. */
export function tenantWrites(src) {
  const found = [];
  // supabase-js: .from("tenants") then, in the same statement, a write.
  for (const m of src.matchAll(/\.from\(\s*["'`]tenants["'`]\s*\)/g)) {
    const end = src.indexOf(";", m.index);
    const chain = src.slice(m.index, end === -1 ? undefined : end);
    const w = /\.(update|insert|upsert|delete)\s*\(/.exec(chain);
    if (w) found.push(`.from("tenants").${w[1]}()`);
  }
  // The REST helpers in _shared/supabase.ts.
  for (const m of src.matchAll(/\b(sbInsert|sbUpsert|sbUpdate)\s*\(\s*["'`]tenants\b/g)) found.push(`${m[1]}("tenants")`);
  // SQL.
  for (const m of src.matchAll(/\b(update|insert\s+into|delete\s+from|alter\s+table|truncate)\s+(?:only\s+)?(?:public\.)?"?tenants"?\b/gi)) {
    found.push(m[0].replace(/\s+/g, " "));
  }
  return found;
}

test("the check finds every kind of write it looks for", () => {
  assert.deepEqual(tenantWrites(`await supabase.from("tenants").update({ a: 1 }).eq("id", x);`), ['.from("tenants").update()']);
  assert.deepEqual(tenantWrites(`await sb.from('tenants').insert({ name });`), ['.from("tenants").insert()']);
  assert.deepEqual(tenantWrites(`await supabase\n  .from("tenants")\n  .upsert(row);`), ['.from("tenants").upsert()']);
  assert.deepEqual(tenantWrites(`await sbUpdate("tenants?id=eq.1", {});`), ['sbUpdate("tenants")']);
  assert.deepEqual(tenantWrites(`update public.tenants set config = '{}';`), ["update public.tenants"]);
  assert.deepEqual(tenantWrites(`alter table public.tenants add column x text;`), ["alter table public.tenants"]);
  // Reads are fine.
  assert.deepEqual(tenantWrites(`await supabase.from("tenants").select("id, name").eq("crm_sync", "zoho");`), []);
  assert.deepEqual(tenantWrites(`select id from public.tenants where crm_sync = 'zoho';`), []);
  assert.deepEqual(tenantWrites(`tenant_id uuid primary key references public.tenants(id) on delete no action,`), []);
});

test("no PS code writes to public.tenants, except company administration in orgs.html", () => {
  const offenders = [];
  for (const rel of files(ROOT)) {
    if (ALLOWED.has(rel)) continue;
    // Migrations before 0057 are history already applied (0001 created the
    // table, 0012 added a column); from 0057 on, none may write it.
    const migration = /^supabase\/migrations\/(\d{4})_/.exec(rel);
    if (migration && Number(migration[1]) < 57) continue;
    for (const w of tenantWrites(read(rel))) offenders.push(`${rel}: ${w}`);
  }
  assert.deepEqual(offenders, []);
  // And company administration still does what it did.
  assert.ok(tenantWrites(read("orgs.html")).length > 0);
});
