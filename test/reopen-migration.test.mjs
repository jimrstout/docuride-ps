// The one-time reopen of sessions voided before the rule existed (migration
// 0040): the same rule as a void now applies, and only the status changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REOPENED_EVENT, REOPENED_STATUS } from "../supabase/functions/_shared/session-reopen.ts";

const m = readFileSync(new URL("../supabase/migrations/0040_reopen_all_voided_sessions.sql", import.meta.url), "utf8");

test("it follows the migration rules", () => {
  assert.match(m, /^begin;$/m);
  assert.match(m, /^commit;$/m);
  assert.match(m, /set local lock_timeout = '5s';/);
  assert.match(m, /set local statement_timeout = '120s';/);
  assert.ok(m.indexOf("from pg_locks l") < m.indexOf("update fni.sessions"));
  assert.match(m, /insert into supabase_migrations\.schema_migrations \(version, name, statements, created_by\)[\s\S]*'claude'\s*\);/);
});

test("it reopens by the rule a void uses, and changes only the status", () => {
  assert.match(m, /set status = 'Products Selected'\s*\n\s*where/);
  assert.equal(REOPENED_STATUS, "Products Selected");
  assert.equal((m.match(/^\s*update /gm) ?? []).length, 1);
  assert.match(m, /s\.status = 'Finalized'/);
  assert.match(m, /s\.submit_state = 'Idle'/);
  assert.match(m, /ap\.status in \('Live', 'Submit Status Unknown'\)/);
  assert.match(m, /s\.deal_number is distinct from '14957'/);
  assert.match(m, /s\.updated_at = timestamptz/);
  assert.doesNotMatch(m, /selected_products|rated_offers|verification_state|sale_date|_price/);
});

test("it writes the same event as a void, by System", () => {
  assert.match(m, new RegExp(`'${REOPENED_EVENT}',`));
  assert.match(m, /'System'\s*\n\s*from reopened r;/);
});
