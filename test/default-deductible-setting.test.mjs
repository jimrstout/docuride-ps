// Administration > Menus, "Default deductible": one setting, in the words
// staff see, initially "$100 disappearing deductible", kept in PS's own
// settings (fni.ps_settings, migration 0057). Mock values only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEDUCTIBLE_CHOICES, DEFAULT_DEDUCTIBLE, parseDeductible, settingOf } from "../supabase/functions/_shared/default-deductible.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("the setting is the words staff see, and starts at $100 disappearing deductible", () => {
  assert.equal(DEFAULT_DEDUCTIBLE, "$100 disappearing deductible");
  assert.deepEqual([...DEDUCTIBLE_CHOICES], [
    "No deductible", "$50 deductible", "$100 deductible", "$100 disappearing deductible", "$250 deductible", "$500 deductible",
  ]);
  assert.deepEqual(parseDeductible("$100 disappearing deductible"), { amount: 100, disappearing: true });
  assert.deepEqual(parseDeductible("$50 deductible"), { amount: 50, disappearing: false });
  assert.deepEqual(parseDeductible("No deductible"), { amount: 0, disappearing: false });
  assert.equal(parseDeductible("$100 disappearing"), null, "the words from #150 are not a setting any more");
  assert.equal(parseDeductible("100 Dis Ded"), null, "the provider's code is not a setting");
  assert.equal(parseDeductible("-1"), null);
});

test("the choices are exactly what the database allows", () => {
  const sql = read("supabase/migrations/0057_ps_settings.sql");
  const allowed = sql.slice(sql.indexOf("check (default_deductible in ("), sql.indexOf("))", sql.indexOf("check (default_deductible in (")));
  assert.deepEqual([...allowed.matchAll(/'([^']+)'/g)].map((m) => m[1]), [...DEDUCTIBLE_CHOICES]);
  assert.match(sql, /default_deductible\s+text not null default '\$100 disappearing deductible'/);
});

test("nothing stored, or something unusable, reads as $100 disappearing deductible", () => {
  assert.equal(settingOf(null), "$100 disappearing deductible");
  assert.equal(settingOf("$1,000 deductible"), "$100 disappearing deductible");
  assert.equal(settingOf("$50 deductible"), "$50 deductible");
});

test("it is read from fni.ps_settings, and a manager's save upserts it there, then logs it", () => {
  const rule = read("supabase/functions/_shared/default-deductible.ts");
  assert.match(rule, /\.schema\("fni"\)\.from\("ps_settings"\)\.select\("default_deductible"\)\.eq\("tenant_id", tenantId\)\.maybeSingle\(\);\s*if \(error\) return DEFAULT_DEDUCTIBLE;/);
  assert.doesNotMatch(rule, /from\("tenants"\)/);
  const t = read("supabase/functions/fni-admin-settings/templates.ts");
  const save = t.slice(t.indexOf('case "save_default_deductible": {'), t.indexOf('case "save": {'));
  assert.match(save, /if \(!\(await isManager\(supabase, body\.operator_id\)\)\) return \{ status: 403, body: \{ error: MANAGERS_ONLY \} \};/);
  assert.match(save, /if \(!parseDeductible\(value\)\)/);
  assert.match(save, /\.schema\("fni"\)\.from\("ps_settings"\)\.upsert\(\s*\{ tenant_id: tenantId, default_deductible: value, updated_at: new Date\(\)\.toISOString\(\), updated_by: by \},\s*\{ onConflict: "tenant_id" \},\s*\);/);
  // The change log only after the save succeeded.
  const upsert = save.indexOf(".upsert(");
  const failed = save.indexOf("if (error) return { status: 500");
  const logged = save.indexOf("await logChanges(");
  assert.ok(upsert > 0 && upsert < failed && failed < logged, "save, stop on failure, then log");
  assert.match(save, /record_key: "Default deductible"/);
  assert.doesNotMatch(save, /from\("tenants"\)/);
  assert.match(t, /default_deductible: await readDefaultDeductible\(supabase, tenantId\),/);
  const page = read("apps/ownership-planner/app/admin/menus/page.tsx");
  assert.match(page, /<h2 id="deductible-title">Default deductible<\/h2>/);
  assert.match(page, /<form action=\{saveDefaultDeductible\}/);
  assert.match(read("apps/ownership-planner/app/console-actions.ts"), /action: "save_default_deductible", default_deductible: field\(fd, "default_deductible"\)/);
});
