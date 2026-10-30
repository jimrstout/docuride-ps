// A deal's day is its store's (2026-10-27). Each store has its own time zone
// (Administration > Stores). Since migration 0044 the CRM sale date is the only
// sale date: the session is open through it, and contracts are submitted only
// on it, today at the store. Renew for Today and the planned sale date are
// retired.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dayLabel,
  isStoreTimeZone,
  contractDateLine,
  saleDateLine,
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

test("a contract is submitted only on the CRM sale date, today at the store", () => {
  const today = "2026-10-27";
  assert.equal(submitDateProblem({ sale: today, inService: today, today }), null);
  assert.equal(submitDateProblem({ sale: today, inService: "2026-01-02", today }), null);
  assert.equal(
    submitDateProblem({ sale: "2026-09-26", inService: "2026-09-26", today: "2026-10-30" }),
    "The sale date in the CRM is 26 Sep 2026. Contracts can only be submitted on the sale date, and today is 30 Oct 2026 at this store. Change the Sale Date in the CRM."
  );
  assert.equal(submitDateProblem({ sale: "2026-10-28", inService: null, today }), saleDateLine("2026-10-28", today));
  assert.match(
    submitDateProblem({ sale: today, inService: "2026-10-30", today }),
    /^The in-service date \(30 Oct 2026\) is after the sale date \(27 Oct 2026\)\./
  );
  // A missing sale date is deal-dates.ts's to say.
  assert.equal(submitDateProblem({ sale: null, inService: null, today }), null);
  assert.equal(dayLabel("2026-01-05"), "5 Jan 2026");
});

test("a live contract dated otherwise than the CRM sale date is named, and nothing more", () => {
  assert.equal(
    contractDateLine({ name: "Battery Protection", contract_number: "SAMPLE-BT-1", dated: "2026-10-28" }, "2026-09-26"),
    "Battery Protection (contract SAMPLE-BT-1) is dated 28 Oct 2026, but the sale date in the CRM is 26 Sep 2026. Void it and submit again on the sale date."
  );
  assert.equal(contractDateLine({ name: "Tire and Wheel", contract_number: "SAMPLE-TW-1", dated: "2026-09-26" }, "2026-09-26"), null);
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

test("Renew for Today is retired: the endpoint says so and renews nothing", () => {
  const f = src("supabase/functions/fni-admin-sessions/index.ts");
  assert.match(f, /if \(req\.method === "POST"\) \{\s*return json\(410, \{/);
  assert.doesNotMatch(f, /renew_session|session_renew_targets|renewable|planned_sale_date|staff_edits/);
});

test("submit reads the CRM sale date first, and refuses one that is not today at the store", () => {
  const f = src("supabase/functions/fni-contract-submit/index.ts");
  assert.match(f, /const crmRead = await freshSaleDate\(supabase, session as unknown as SaleDateSession, SUBMIT_CRM_BUDGET_MS\);/);
  assert.match(f, /if \(!crmRead\.fresh && !\(noCrmRecord && session\.is_test === true\)\) \{\s*return await refuse\(503,/);
  assert.ok(f.indexOf("const crmRead = await freshSaleDate(") < f.indexOf("const dates = dealDates("));
  assert.doesNotMatch(f, /planned_sale_date/);
  assert.match(f, /const today = storeToday\(/);
  assert.match(f, /const dayProblem = submitDateProblem\(\{/);
  assert.match(f, /if \(dayProblem\) return await refuse\(400, \{ error: dayProblem \}\);/);
  // After the dates check and before anything is sent.
  assert.ok(f.indexOf("const dayProblem") > f.indexOf("const dates = dealDates("));
  assert.ok(f.indexOf("const dayProblem") < f.indexOf("Step 4: Cut the quote down"));
});

test("Details reads the CRM sale date as it loads, and says what Submit would", () => {
  const f = src("supabase/functions/fni-session-verify/index.ts");
  assert.doesNotMatch(f, /"planned_sale_date",|setPlannedSaleDate|renew_session|saleDateChoice/);
  assert.match(f, /const crmRead = await freshSaleDate\(supabase, loaded as unknown as \{ id: string \}\);/);
  assert.match(f, /day: await dayFor\(supabase, s, edited, crmRead\),/);
  assert.match(f, /if \(action === "planned_sale_date" \|\| action === "sale_date_keep_staff" \|\| action === "sale_date_use_crm"\) \{\s*return json\(410, \{ error: SALE_DATE_IN_CRM \}\);/);
  assert.match(f, /date_line: dates\.sale !== null && dates\.sale !== today \? saleDateLine\(dates\.sale, today\) : null,/);
});

test("Administration sets each store's time zone, from the listed zones only", () => {
  const settings = src("supabase/functions/fni-admin-settings/index.ts");
  assert.match(settings, /if \(section === "stores"\) \{/);
  assert.match(settings, /if \(body\.section === "stores"\) \{/);
  const stores = src("supabase/functions/fni-admin-settings/stores.ts");
  assert.match(stores, /if \(!isStoreTimeZone\(body\.time_zone\)\) \{/);
  assert.match(stores, /\.update\(\{ time_zone: body\.time_zone \}\)\s*\.eq\("id", body\.store_id\)\s*\.eq\("tenant_id", tenantId\)/);
});

test("Sessions has no Renew for Today: a session runs through its CRM sale date", async () => {
  const page = src("apps/ownership-planner/app/admin/sessions/page.tsx");
  assert.doesNotMatch(page, /renewSession|Renew for Today|renewable|renew_to/);
  assert.match(page, /\? "Ended with its sale date"/);
  assert.doesNotMatch(page, />\s*\+24h\s*<|extendSession|Adding 24 hours/);
  const actions = src("apps/ownership-planner/app/console-actions.ts");
  assert.doesNotMatch(actions, /adminRenew|renewSession|EXTEND_HOURS|adminExtend/);
  assert.doesNotMatch(src("apps/ownership-planner/lib/edge.ts"), /adminRenew/);
  const { storeTime } = await import("../apps/ownership-planner/lib/store-time.ts");
  assert.equal(storeTime("2026-10-28T03:59:59Z", "America/New_York"), "11:59 PM, 27 Oct (EDT)");
  assert.equal(storeTime("2026-10-28T04:59:59Z", "America/Chicago"), "11:59 PM, 27 Oct (CDT)");
  assert.equal(storeTime("2026-10-28T03:59:59Z", "Not/AZone"), "11:59 PM, 27 Oct (EDT)");
  assert.equal(storeTime(null, "America/Chicago"), "");
});

test("Details: one date line with Open in CRM, no date controls of its own, and Submit pointing to it", async () => {
  const page = src("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(page, /<dt>Open until<\/dt>/);
  // Gone: the planned sale date, its Save date and Clear, and Keep staff value / Use CRM value.
  assert.doesNotMatch(page, /setPlannedSaleDate|clearPlannedSaleDate|vplanned|planned_sale_date|sale_date_choice|keepStaffSaleDate|useCrmSaleDate/);
  // The one date line, with the CRM record in a new tab and the watcher.
  assert.match(page, /const dateLine = sheet\.day\?\.date_line \?\? \(sheet\.day && !sheet\.day\.sale_date \? NO_SALE_DATE_LINE : null\);/);
  assert.match(page, /<a className="btn btn--quiet" href=\{crmUrl\} target="_blank" rel="noopener">\s*Open in CRM\s*<\/a>/);
  assert.match(page, /<SaleDateWatch \/>\s*<\/div>\s*\) : null\}/);
  assert.ok(page.indexOf("{dateLine ? (") < page.indexOf('<dl className="vstate">'));
  // Live contracts dated otherwise, named in the Contracts panel.
  assert.match(page, /\{sheet\.day!\.contract_date_lines!\.map\(\(l\) => <li key=\{l\}>\{l\}<\/li>\)\}/);
  // Submit says once that it waits for the date, rather than the date again.
  assert.match(page, /dateLine && submitCheckBlock === sheet\.day\?\.submit_problem \? SUBMIT_HELD_FOR_DATE : submitCheckBlock;/);
  assert.match(page, /blocked=\{\s*submitBlocked \?\?/);
  const modal = src("apps/ownership-planner/components/SubmitConfirm.tsx");
  assert.match(modal, /\{blocked \? \(\s*<p className="console-flash console-flash--bad" role="alert">\{blocked\}<\/p>/);
  assert.match(modal, /onClick=\{show\} disabled=\{!!blocked\}/);
  assert.match(modal, /pending="Submitting contracts\.\.\."/);
  const actions = src("apps/ownership-planner/app/console-actions.ts");
  assert.doesNotMatch(actions, /planned_sale_date|sale_date_keep_staff|sale_date_use_crm/);

  const link = await import("../apps/ownership-planner/lib/crm-link.ts");
  assert.equal(link.crmRecordUrl("4742556000231058020"), "https://crm.zoho.com/crm/org735391176/tab/CustomModule24/4742556000231058020");
  assert.equal(link.crmRecordUrl("13759"), null);
  assert.equal(link.crmRecordUrl(null), null);
  assert.equal(link.NO_SALE_DATE_LINE, "There is no sale date in the CRM. Add the Sale Date in the CRM.");
  assert.equal(link.DATE_WATCH_MS, 30000);

  // The watcher: on focus and every 30 seconds, never while the page is working.
  const watch = src("apps/ownership-planner/components/SaleDateWatch.tsx");
  assert.match(watch, /^"use client";/);
  assert.match(watch, /window\.setInterval\(check, DATE_WATCH_MS\)/);
  assert.match(watch, /window\.addEventListener\("focus", check\)/);
  assert.match(watch, /if \(document\.querySelector\('\[aria-busy="true"\]'\)\) return;/);
  assert.match(watch, /router\.refresh\(\);/);

  const { flashMessage } = await import("../apps/ownership-planner/lib/verify-flash.ts");
  for (const code of ["planned", "plannedcleared", "saledatekept", "saledatecrm"]) {
    assert.doesNotMatch(flashMessage({ code, detail: null })?.text ?? "", /[Pp]lanned sale date|staff sale date/, code);
  }
});

test("Administration > Stores sets each store's time zone", () => {
  const page = src("apps/ownership-planner/app/admin/stores/page.tsx");
  assert.match(page, /payload = await edge\.adminStores<StoresPayload>\(\);/);
  assert.match(page, /<form action=\{saveStoreTimeZone\} className="ad-inline-form" data-working-panel="">/);
  assert.match(page, /<select id=\{`tz-\$\{s\.id\}`\} name="time_zone" defaultValue=\{s\.time_zone\}>/);
  assert.match(page, /const operator = await currentOperator\(\);\s*if \(!operator\) return null;/);
  const actions = src("apps/ownership-planner/app/console-actions.ts");
  assert.match(actions, /edge\.adminSaveStore\(\{ store_id: field\(fd, "store_id"\), time_zone: field\(fd, "time_zone"\), updated_by: by \}\)/);
  const sections = src("apps/ownership-planner/lib/admin-sections.ts");
  assert.match(sections, /\{ href: "\/admin\/stores", label: "Stores", icon: "stores" \},/);
});

test("a Submit held off the sale day looks disabled", () => {
  assert.match(src("apps/ownership-planner/app/globals.css"), /\.vcontracts \.btn\[disabled\]:not\(\.is-busy\) \{ opacity: 0\.45; cursor: not-allowed; \}/);
});
