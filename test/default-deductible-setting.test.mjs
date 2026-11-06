// Administration > Menus, "Default deductible" (6 Nov 2026): one setting, in
// words, initially "$100 disappearing". Mock values only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEDUCTIBLE_CHOICES, DEFAULT_DEDUCTIBLE, defaultDeductibleOf, parseDeductible } from "../supabase/functions/_shared/default-deductible.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("the setting is words a person reads, and starts at $100 disappearing", () => {
  assert.equal(DEFAULT_DEDUCTIBLE, "$100 disappearing");
  assert.ok(DEDUCTIBLE_CHOICES.includes("$100 disappearing"));
  assert.deepEqual(parseDeductible("$100 disappearing"), { amount: 100, disappearing: true });
  assert.deepEqual(parseDeductible("$50"), { amount: 50, disappearing: false });
  assert.deepEqual(parseDeductible("No deductible"), { amount: 0, disappearing: false });
  assert.equal(parseDeductible("100 Dis Ded"), null, "the provider's code is not a setting");
  assert.equal(parseDeductible("-1"), null);
});

test("nothing stored, or something unusable, reads as $100 disappearing", () => {
  assert.equal(defaultDeductibleOf(null), "$100 disappearing");
  assert.equal(defaultDeductibleOf({}), "$100 disappearing");
  assert.equal(defaultDeductibleOf({ default_deductible: "$1,000" }), "$100 disappearing");
  assert.equal(defaultDeductibleOf({ default_deductible: "$50" }), "$50");
});

test("a manager saves it in words on the tenant's record, logged as a preset change", () => {
  const t = read("supabase/functions/fni-admin-settings/templates.ts");
  const save = t.slice(t.indexOf('case "save_default_deductible": {'), t.indexOf('case "save": {'));
  assert.match(save, /if \(!\(await isManager\(supabase, body\.operator_id\)\)\) return \{ status: 403, body: \{ error: MANAGERS_ONLY \} \};/);
  assert.match(save, /if \(!parseDeductible\(value\)\)/);
  assert.match(save, /record_key: "Default deductible"/);
  assert.match(save, /\.from\("tenants"\)\.update\(\{ config: \{ \.\.\.config, default_deductible: value \} \}\)/);
  assert.match(t, /default_deductible: await readDefaultDeductible\(supabase, tenantId\),/);
  const page = read("apps/ownership-planner/app/admin/menus/page.tsx");
  assert.match(page, /<h2 id="deductible-title">Default deductible<\/h2>/);
  assert.match(page, /<form action=\{saveDefaultDeductible\}/);
  assert.match(read("apps/ownership-planner/app/console-actions.ts"), /action: "save_default_deductible", default_deductible: field\(fd, "default_deductible"\)/);
});
