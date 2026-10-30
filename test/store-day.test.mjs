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

test("Sessions offers Renew for Today, not +24h, and only when it gives longer", async () => {
  const page = src("apps/ownership-planner/app/admin/sessions/page.tsx");
  assert.match(page, /\{row\.renewable \? \(\s*<form action=\{renewSession\}>/);
  assert.match(page, /pending="Renewing for today\.\.\."/);
  assert.match(page, />\s*Renew for Today\s*<\/PendingButton>/);
  assert.doesNotMatch(page, />\s*\+24h\s*<|extendSession|Adding 24 hours/);
  const actions = src("apps/ownership-planner/app/console-actions.ts");
  assert.match(actions, /await edge\.adminRenew<\{ expires_at: string \}>\(sessionId, initialsFor\(operator\.email\)\);/);
  assert.doesNotMatch(actions, /EXTEND_HOURS|adminExtend/);
  const { storeTime } = await import("../apps/ownership-planner/lib/store-time.ts");
  assert.equal(storeTime("2026-10-28T03:59:59Z", "America/New_York"), "11:59 PM, 27 Oct (EDT)");
  assert.equal(storeTime("2026-10-28T04:59:59Z", "America/Chicago"), "11:59 PM, 27 Oct (CDT)");
  assert.equal(storeTime("2026-10-28T03:59:59Z", "Not/AZone"), "11:59 PM, 27 Oct (EDT)");
  assert.equal(storeTime(null, "America/Chicago"), "");
});

test("Details shows when the deal ends, sets the planned sale date, and holds Submit off the sale day", async () => {
  const page = src("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(page, /<dt>Open until<\/dt>/);
  assert.match(page, /<form action=\{setPlannedSaleDate\} className="vplanned" data-working-panel="">/);
  assert.match(page, /min=\{sheet\.day\.today\}/);
  assert.match(page, /<PendingButton formAction=\{clearPlannedSaleDate\} formNoValidate pending="Clearing the date\.\.\.">/);
  // The reason (not the sale day, or a rating out of date) is said beside a
  // disabled Submit (lib/submit-check.ts).
  assert.match(page, /const \{ block: submitBlocked, note: submitNote \} = submitCheck\(sheet\);/);
  assert.match(page, /blocked=\{\s*submitBlocked \?\?/);
  const modal = src("apps/ownership-planner/components/SubmitConfirm.tsx");
  assert.match(modal, /\{blocked \? \(\s*<p className="console-flash console-flash--bad" role="alert">\{blocked\}<\/p>/);
  assert.match(modal, /onClick=\{show\} disabled=\{!!blocked\}/);
  // Submit and Confirm and Continue (which rates) are busy buttons.
  assert.match(modal, /pending="Submitting contracts\.\.\."/);
  const actions = src("apps/ownership-planner/app/console-actions.ts");
  assert.match(actions, /\(session_id\) => \(\{ session_id, action: "planned_sale_date", value \}\)/);
  const { flashMessage } = await import("../apps/ownership-planner/lib/verify-flash.ts");
  assert.equal(flashMessage({ code: "planned", detail: null }).text, "Planned sale date saved. This deal stays open until the end of that day.");
  assert.equal(flashMessage({ code: "plannedcleared", detail: null }).text, "Planned sale date cleared. This deal stays open until the end of today.");
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
