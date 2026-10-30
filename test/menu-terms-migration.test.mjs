// Migration 0046: multiple payment terms and the customer's product choices.
// Additive only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const m = readFileSync(new URL("../supabase/migrations/0046_menu_terms_and_choices.sql", import.meta.url), "utf8");
const code = m.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

test("it follows the migration rules, changes no row and drops nothing", () => {
  assert.match(m, /^begin;$/m);
  assert.match(m, /^commit;$/m);
  assert.match(m, /set local lock_timeout = '5s';/);
  assert.match(m, /set local statement_timeout = '120s';/);
  assert.ok(m.indexOf("from pg_locks l") < m.indexOf("create table"));
  assert.match(m, /insert into supabase_migrations\.schema_migrations \(version, name, statements, created_by\)[\s\S]*'claude'\s*\);/);
  assert.doesNotMatch(code, /\bdrop\b|\bdelete from\b|\bupdate fni\./i);
});

test("extra terms: at most two per column, each with its own rate", () => {
  assert.match(code, /slot int not null check \(slot between 1 and 2\)/);
  assert.match(code, /unique \(template_id, column_position, slot\)/);
  assert.match(code, /check \(\(term_months is null\) = \(rate_percent is null\)\)/);
  for (const c of ["menu_terms jsonb", "menu_removed jsonb", "menu_choice jsonb"]) {
    assert.match(code, new RegExp(`alter table fni\\.sessions add column if not exists ${c};`), c);
  }
});
