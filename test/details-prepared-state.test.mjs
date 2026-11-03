// Details learns whether Prepare presentation has been done for the deal.
//
// The prepared state already exists: fni-menu-prepare writes menu_prepared,
// menu_prepared_at and menu_prepared_by on save (migration 0045). Details'
// sheet now carries the when and who, so the page can show one next step:
// Rate, then Prepare presentation, then Present. No migration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifySource } from "./details-source.mjs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("the prepared state is the one Prepare already writes", () => {
  const prep = read("supabase/functions/fni-menu-prepare/index.ts");
  assert.match(prep, /menu_prepared_at: now,/);
  assert.match(prep, /menu_prepared_by: who,/);
  assert.match(read("supabase/migrations/0045_menu_presets.sql"), /add column if not exists menu_prepared_at timestamptz;/);
});

test("the Details sheet reads it and says it, null until Prepare has been saved", () => {
  const fn = verifySource();
  const columns = fn.slice(fn.indexOf("const COLUMNS = ["), fn.indexOf('].join(",");', fn.indexOf("const COLUMNS = [")));
  assert.match(columns, /"menu_prepared_at", "menu_prepared_by",/);
  assert.match(fn, /prepared: s\.menu_prepared_at\s*\? \{ at: s\.menu_prepared_at as string, by: \(s\.menu_prepared_by as string \| null\) \?\? null \}\s*: null,/);
  // The cells themselves stay on Prepare's side: Details needs only the fact.
  assert.doesNotMatch(columns, /"menu_prepared",/);
});
