// TEMPORARY: the co-buyer field test on Verify. Delete with the probe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("offered on test sessions on the QA server only, read from the base URL alone", () => {
  const v = src("../supabase/functions/fni-session-verify/index.ts");
  assert.match(v, /cobuyer_probe_available: s\.is_test === true && \(await onQaServer\(supabase, String\(s\.store_id\)\)\),/);
  assert.match(v, /\.from\("provider_credentials"\)\s+\.select\("api_base_url"\)/);
  assert.match(v, /\?\.api_base_url\) === QA_HOST;/);
});

test("the checkbox is off by default, explained, with a batch picker defaulting to All", () => {
  const page = src("../apps/ownership-planner/app/verify/[sessionId]/page.tsx");
  const block = page.slice(page.indexOf("{sheet.contracts_panel.cobuyer_probe_available ? ("), page.indexOf("Submit contracts to {sheet.contracts_panel.provider_name}"));
  assert.match(block, /<input type="checkbox" name="cobuyer_probe" value="1" \/> Co-buyer field test/);
  assert.doesNotMatch(block, /defaultChecked|checked=/);
  assert.match(block, /No real names are sent\./);
  assert.match(block, /<select name="cobuyer_probe_batch" defaultValue="All">/);
  for (const o of ["All", "Batch 1", "Batch 2", "Batch 3"]) assert.ok(block.includes(`>${o}</option>`), o);
});

test("the action sends the flag only when ticked", () => {
  const a = src("../apps/ownership-planner/app/console-actions.ts");
  assert.match(a, /const probe = formData\.get\("cobuyer_probe"\) === "1";/);
  assert.match(a, /\.\.\.\(probe \? \{ cobuyer_probe: true, cobuyer_probe_batch: probeBatch \} : \{\}\),/);
});
