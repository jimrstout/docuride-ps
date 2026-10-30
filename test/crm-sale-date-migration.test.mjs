// Migration 0044: the CRM sale date is the only sale date. The expiry follows
// it, staff sale dates are retired, contracts record the date they were sent
// with, and one function records a Sale_Date read from the CRM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const m = readFileSync(new URL("../supabase/migrations/0044_crm_sale_date_only.sql", import.meta.url), "utf8");
const code = m.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

test("it follows the migration rules, and drops nothing", () => {
  assert.match(m, /^begin;$/m);
  assert.match(m, /^commit;$/m);
  assert.match(m, /set local lock_timeout = '5s';/);
  assert.match(m, /set local statement_timeout = '120s';/);
  assert.ok(m.indexOf("from pg_locks l") < m.indexOf("create or replace function"));
  assert.match(m, /insert into supabase_migrations\.schema_migrations \(version, name, statements, created_by\)[\s\S]*'claude'\s*\);/);
  assert.doesNotMatch(code, /\bdrop\b/i);
});

test("the session is open through its sale date at the store, set on insert and on every sale date change", () => {
  assert.match(code, /select fni\.store_day_end\(p_store, coalesce\(p_sale, fni\.store_today\(p_store\)\)\)/);
  assert.match(code, /new\.expires_at := fni\.session_sale_day_end\(new\.store_id, new\.sale_date\);/);
  assert.match(code, /create or replace trigger sessions_set_expiry\s+before insert or update of sale_date, store_id on fni\.sessions/);
  assert.doesNotMatch(code, /planned_sale_date\s*[,)]/);
});

test("staff sale dates are retired with an event, and 14957 is left out of every data change", () => {
  assert.match(code, /'Staff sale date retired: the CRM sale date is used',/);
  assert.match(code, /set staff_edits = s\.staff_edits - 'sale_date'/);
  assert.equal((code.match(/coalesce\(s\.deal_number, ''\) <> '14957'/g) ?? []).length, 4);
});

test("contracts record the sale date they were sent with; existing live ones the day they were submitted", () => {
  assert.match(code, /alter table fni\.agreement_products add column if not exists contract_sale_date date;/);
  assert.match(code, /set contract_sale_date = \(ap\.created_at at time zone fni\.store_time_zone\(s\.store_id\)\)::date/);
  assert.match(code, /ap\.status in \('Live', 'Submit Status Unknown'\)/);
});

test("record_crm_sale_date writes only over the value the caller read, with one System event", () => {
  assert.match(code, /if s\.sale_date is distinct from p_expected then\s+return query select 'Changed meanwhile'/);
  assert.match(code, /'Sale date changed in the CRM from ' \|\| coalesce\(to_char\(s\.sale_date, fmt\), 'none'\)/);
  assert.match(code, /fmt constant text := 'FMDD Mon YYYY';/);
  assert.match(code, /'System'\s*\);\s*return query select 'Changed'/);
  // The month rule is the caller's (saleDateMoveNeedsRerate); a re-rate marks offers, never prices.
  assert.match(code, /if p_rerate then update fni\.rated_offers set out_of_date = true where session_id = p_session; end if;|if p_rerate then\s+update fni\.rated_offers set out_of_date = true where session_id = p_session;\s+end if;/);
  assert.doesNotMatch(code, /_price|selected_products/);
  assert.match(code, /grant execute on function fni\.record_crm_sale_date\(uuid, date, date, boolean\) to service_role;/);
});
