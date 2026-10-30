// Migration 0045: menu presets and per-deal menu preparation. Additive only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const m = readFileSync(new URL("../supabase/migrations/0045_menu_presets.sql", import.meta.url), "utf8");
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

test("presets: per template, Financed or Cash, column and category", () => {
  assert.match(code, /deal_type text not null check \(deal_type in \('Financed', 'Cash'\)\)/);
  assert.match(code, /column_position int not null check \(column_position between 1 and 5\)/);
  assert.match(code, /unique \(template_id, deal_type, column_position, category\)/);
  for (const c of ["provider_id uuid", "product_code text", "term_months int", "term_miles int", "deductible numeric\\(12,2\\)", "disappearing_deductible boolean"]) {
    assert.match(code, new RegExp(c), c);
  }
});

test("the staff band, the change log, a deal's prices and the prepared menu", () => {
  assert.match(code, /add column if not exists max_markup_percent numeric\(8,3\)/);
  assert.match(code, /add column if not exists max_markup_dollars numeric\(12,2\)/);
  assert.match(code, /area text not null check \(area in \('Menu preset', 'Price band'\)\)/);
  assert.match(code, /grant select, insert on fni\.admin_change_log to service_role;/);
  assert.match(code, /unique \(session_id, option_key\)/);
  assert.match(code, /check \(not above_band or \(approved_by is not null and coalesce\(trim\(reason\), ''\) <> ''\)\)/);
  for (const c of ["menu_prepared jsonb", "menu_surcharges text\\[\\] not null default '\\{\\}'", "menu_prepared_at timestamptz", "menu_prepared_by text", "menu_prices_locked_at timestamptz"]) {
    assert.match(code, new RegExp(`alter table fni\\.sessions add column if not exists ${c};`), c);
  }
});

test("a manager is a profile with the owner or admin role", () => {
  assert.match(code, /select coalesce\(\(select p\.role in \('owner', 'admin'\) from public\.profiles p where p\.user_id = p_user\), false\)/);
  assert.match(code, /grant execute on function fni\.is_menu_manager\(uuid\) to service_role;/);
});
