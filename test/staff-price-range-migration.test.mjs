// Migration 0047: the staff price range as a manager setting. Additive only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const m = readFileSync(new URL("../supabase/migrations/0047_staff_price_range.sql", import.meta.url), "utf8");
const code = m.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

test("it follows the migration rules, changes no value and drops nothing", () => {
  assert.match(m, /^begin;$/m);
  assert.match(m, /^commit;$/m);
  assert.match(m, /set local lock_timeout = '5s';/);
  assert.match(m, /set local statement_timeout = '120s';/);
  assert.ok(m.indexOf("from pg_locks l") < m.indexOf("alter table"));
  assert.match(m, /insert into supabase_migrations\.schema_migrations \(version, name, statements, created_by\)[\s\S]*'claude'\s*\);/);
  assert.doesNotMatch(code, /\bdrop\b|\bdelete from\b|\bupdate fni\./i);
});

test("a band says whether a manager has reviewed it; a deal price can be below the band with a manager", () => {
  assert.match(code, /alter table fni\.pricing_rules add column if not exists band_reviewed_at timestamptz;/);
  assert.match(code, /alter table fni\.pricing_rules add column if not exists band_reviewed_by text;/);
  assert.match(code, /alter table fni\.session_menu_prices add column if not exists below_band boolean not null default false;/);
});
