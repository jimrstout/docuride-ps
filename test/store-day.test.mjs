// A session lasts to the end of its store's day (2026-10-27). Each store has
// its own time zone (Administration > Stores). Renew for Today replaces +24h
// and cannot stack. A planned sale date lets a deal be prepared the night
// before. Contracts are submitted only on the day of the sale.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dayLabel,
  isStoreTimeZone,
  plannedDateProblem,
  STORE_TIME_ZONES,
  storeToday,
  submitDateProblem,
} from "../supabase/functions/_shared/store-day.ts";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("today is the store's own calendar day", () => {
  // 03:30 UTC on 28 Oct is still the evening of the 27th in the US.
  const late = new Date("2026-10-28T03:30:00Z");
  assert.equal(storeToday("America/New_York", late), "2026-10-27");
  assert.equal(storeToday("America/Los_Angeles", late), "2026-10-27");
  assert.equal(storeToday("Pacific/Honolulu", late), "2026-10-27");
  // 04:30 UTC: past midnight in New York, still the 27th in Chicago and west.
  const later = new Date("2026-10-28T04:30:00Z");
  assert.equal(storeToday("America/New_York", later), "2026-10-28");
  assert.equal(storeToday("America/Chicago", later), "2026-10-27");
  // An unknown or missing zone is New York's.
  assert.equal(storeToday(null, later), "2026-10-28");
  assert.equal(storeToday("Mars/Olympus", later), "2026-10-28");
});

test("only the listed zones can be set", () => {
  assert.equal(STORE_TIME_ZONES[0].zone, "America/New_York");
  assert.ok(isStoreTimeZone("America/Phoenix"));
  assert.ok(!isStoreTimeZone("Europe/London"));
  assert.ok(!isStoreTimeZone(""));
});

test("a contract is submitted only on the day of the sale", () => {
  const today = "2026-10-27";
  assert.equal(submitDateProblem({ sale: today, inService: today, planned: null, today }), null);
  assert.equal(submitDateProblem({ sale: today, inService: "2026-01-02", planned: today, today }), null);
  assert.match(
    submitDateProblem({ sale: "2026-10-26", inService: "2026-10-26", planned: null, today }),
    /^The sale date is 26 Oct 2026\. Contracts can only be submitted on the day of the sale, and today is 27 Oct 2026 at this store\./
  );
  assert.match(submitDateProblem({ sale: "2026-10-28", inService: null, planned: null, today }), /^The sale date is 28 Oct 2026\./);
  assert.match(
    submitDateProblem({ sale: today, inService: today, planned: "2026-10-28", today }),
    /^The planned sale date is 28 Oct 2026, but the sale date is 27 Oct 2026\./
  );
  assert.match(
    submitDateProblem({ sale: today, inService: "2026-10-30", planned: null, today }),
    /^The in-service date \(30 Oct 2026\) is after the sale date \(27 Oct 2026\)\./
  );
  // A missing sale date is deal-dates.ts's to say.
  assert.equal(submitDateProblem({ sale: null, inService: null, planned: null, today }), null);
});

test("a planned sale date cannot be in the past", () => {
  assert.equal(plannedDateProblem(null, "2026-10-27"), null);
  assert.equal(plannedDateProblem("2026-10-27", "2026-10-27"), null);
  assert.equal(plannedDateProblem("2026-10-28", "2026-10-27"), null);
  assert.equal(plannedDateProblem("2026-10-26", "2026-10-27"), "The planned sale date cannot be in the past. Today is 27 Oct 2026.");
  assert.equal(plannedDateProblem("tomorrow", "2026-10-27"), "The planned sale date is not a date.");
  assert.equal(dayLabel("2026-01-05"), "5 Jan 2026");
});

test("the migration is additive and puts the day in Postgres", () => {
  const m = src("supabase/migrations/0038_store_time_zone_and_session_day.sql");
  assert.doesNotMatch(m, /\bdrop\b/i);
  assert.match(m, /alter table public\.stores add column if not exists time_zone text not null default 'America\/New_York';/);
  assert.match(m, /alter table fni\.sessions add column if not exists planned_sale_date date;/);
  assert.match(m, /select \(\(p_day \+ 1\)::timestamp at time zone fni\.store_time_zone\(p_store\)\) - interval '1 second'/);
  assert.match(m, /create or replace trigger sessions_set_expiry\s+before insert on fni\.sessions/);
  assert.match(m, /create or replace function fni\.renew_session\(p_session uuid\)/);
  assert.match(m, /revoke all on function fni\.renew_session\(uuid\) from public, anon, authenticated;/);
});

test("Renew for Today replaces +24h and never adds hours", () => {
  const f = src("supabase/functions/fni-admin-sessions/index.ts");
  assert.match(f, /\.rpc\("renew_session", \{ p_session: sessionId \}\)/);
  assert.match(f, /if \(req\.method === "POST"\) return await renew\(req\);/);
  assert.doesNotMatch(f, /hours \* 3600_000/);
  assert.doesNotMatch(f, /MAX_EXTEND_HOURS/);
  assert.match(f, /\.rpc\("session_renew_targets", \{ p_ids: sessionIds \}\)/);
  assert.match(f, /renewable: renewable\(s\),/);
});

test("submit refuses a sale date that is not today at the store", () => {
  const f = src("supabase/functions/fni-contract-submit/index.ts");
  assert.match(f, /const today = storeToday\(/);
  assert.match(f, /const dayProblem = submitDateProblem\(\{/);
  assert.match(f, /if \(dayProblem\) return await refuse\(400, \{ error: dayProblem \}\);/);
  // After the dates check and before anything is sent.
  assert.ok(f.indexOf("const dayProblem") > f.indexOf("const dates = dealDates("));
  assert.ok(f.indexOf("const dayProblem") < f.indexOf("Step 4: Cut the quote down"));
});

test("Details reads and sets the planned sale date, and says what Submit would", () => {
  const f = src("supabase/functions/fni-session-verify/index.ts");
  assert.match(f, /"planned_sale_date",/);
  assert.match(f, /day: await dayFor\(supabase, s, edited\),/);
  assert.match(f, /if \(action === "planned_sale_date"\) return await setPlannedSaleDate\(supabase, s, body\.value\);/);
  assert.match(f, /\.rpc\("renew_session", \{ p_session: s\.id as string \}\)/);
});

test("Administration sets each store's time zone, from the listed zones only", () => {
  const settings = src("supabase/functions/fni-admin-settings/index.ts");
  assert.match(settings, /if \(section === "stores"\) \{/);
  assert.match(settings, /if \(body\.section === "stores"\) \{/);
  const stores = src("supabase/functions/fni-admin-settings/stores.ts");
  assert.match(stores, /if \(!isStoreTimeZone\(body\.time_zone\)\) \{/);
  assert.match(stores, /\.update\(\{ time_zone: body\.time_zone \}\)\s*\.eq\("id", body\.store_id\)\s*\.eq\("tenant_id", tenantId\)/);
});
