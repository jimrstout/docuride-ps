// Existing out-of-date offers brought into line with the same-month rule
// (migration 0039). An offer is marked current only when the sale date is the
// only input that differs from what it was rated on, within the same month,
// with no price sheet boundary between. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keptCurrentEvent, ratedRequestDiff } from "../supabase/functions/_shared/sale-date.ts";
import { checkRow } from "../scripts/same-month-rating-check.mjs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

/** A mock deal, rated on 26 Oct 2026. */
const SESSION = {
  id: "00000000-0000-4000-8000-000000000001",
  vin: "TESTVIN0000000001", condition: "New", sale_date: "2026-10-26", in_service_date: null,
  unit_year: 2026, unit_make: "Sample", unit_model: "Sample Tourer", odometer: 1, sale_price: 20000,
  finance_type: "Loan", amount_financed: 18000, finance_term_total: 60, apr: 6.5, lienholder_name: "Sample Bank",
  buyer_city: "Sampletown", buyer_state: "WV", buyer_zip: "26000", vehicle_type_code: "MCYC",
  vin_decode: { displacement: "1000", fuelType: "G" }, vehicle_properties: null,
  staff_edits: { warranty: { value: "24", original: null, original_source: "Missing", edited_by: "AB", edited_at: "t" } },
};
const NAMES = ["year", "vin", "model", "make", "fuel.type", "engine.ccs", "finance.amount", "finance.apr", "finance.term", "odometer", "price", "new.used", "finance.type", "warranty", "sale.date", "postal.code", "inservice.date"];

/** The request the mock deal was rated with, built by the real builder. */
async function storedFor(session) {
  const { buildRateRequest } = await import("../supabase/functions/_shared/rate-request.ts");
  const { applyStaffEdits, parseStaffEdits } = await import("../supabase/functions/_shared/staff-edits.ts");
  return buildRateRequest(NAMES.map((name) => ({ name })), applyStaffEdits(session, parseStaffEdits(session.staff_edits)), {
    dealerCode: "0-000", vtype: "MCYC", rateDate: "2026-10-26",
  }).request;
}

// The sale date as the CRM now has it (the only sale date, migration 0044).
const saleMoved = (value) => ({ ...SESSION, sale_date: value });

test("only the sale date moved within the month: marked current", async () => {
  const stored = await storedFor(SESSION);
  const d = checkRow({ deal_number: "90001", session: saleMoved("2026-10-28"), stored });
  assert.equal(d.keepCurrent, true);
  assert.deepEqual([d.rated_sale, d.current_sale], ["2026-10-26", "2026-10-28"]);
  // A New unit with no recorded in-service date: it follows the sale date and counts as part of the move.
  assert.ok(d.differs.includes("inServiceDate") && d.differs.includes("prop:inservice.date"));
});

test("a move into another month or year, or across a price sheet boundary, is left out of date", async () => {
  const stored = await storedFor(SESSION);
  assert.equal(checkRow({ deal_number: "90001", session: saleMoved("2026-11-01"), stored }).keepCurrent, false);
  const dec = await storedFor({ ...SESSION, sale_date: "2026-12-31" });
  assert.equal(checkRow({ deal_number: "90001", session: { ...SESSION, sale_date: "2027-01-01" }, stored: dec }).keepCurrent, false);
  assert.equal(checkRow({ deal_number: "90001", session: saleMoved("2026-10-28"), stored }, ["2026-10-27"]).keepCurrent, false);
  assert.equal(checkRow({ deal_number: "90001", session: saleMoved("2026-10-28"), stored }, null).keepCurrent, false);
});

test("any other input that differs leaves it out of date, and is named", async () => {
  const stored = await storedFor(SESSION);
  const d = checkRow({ deal_number: "90001", session: { ...saleMoved("2026-10-28"), odometer: 5 }, stored });
  assert.equal(d.keepCurrent, false);
  assert.ok(d.differs.includes("odometer") && d.differs.includes("prop:odometer"));
  // A Used unit's own in-service date changing is not the sale date's move.
  const used = { ...SESSION, condition: "Used", in_service_date: "2025-01-01" };
  const usedStored = await storedFor(used);
  assert.equal(checkRow({ deal_number: "90002", session: { ...used, ...saleMoved("2026-10-28"), in_service_date: "2025-02-01" }, stored: usedStored }).keepCurrent, false);
});

test("a sale date that did not move is not this rule, whatever else differs", async () => {
  // Rated before rate requests always carried inservice.date: the request lacks it.
  const stored = await storedFor(SESSION);
  stored.properties = stored.properties.filter((p) => p.name !== "inservice.date");
  const d = checkRow({ deal_number: "90003", session: SESSION, stored });
  assert.deepEqual(d.differs, ["prop:inservice.date"]);
  assert.equal(d.keepCurrent, false);
  // Nothing differs at all: not marked either; something else put it out of date.
  assert.equal(ratedRequestDiff(stored, stored).keepCurrent, false);
  // The rate date is when we asked, never a difference.
  assert.deepEqual(ratedRequestDiff({ ...stored, rateDate: "2026-10-26" }, { ...stored, rateDate: "2026-10-28" }).differs, []);
});

test("the session event reads as Jim asked", () => {
  assert.equal(
    keptCurrentEvent("2026-10-27", "2026-10-28"),
    "Rating kept current: sale date moved within the same month (27 Oct 2026 to 28 Oct 2026)"
  );
});

test("the data change follows the migration rules and touches only out_of_date", () => {
  const m = read("supabase/migrations/0039_same_month_rating_current.sql");
  assert.match(m, /^begin;$/m);
  assert.match(m, /^commit;$/m);
  assert.match(m, /set local lock_timeout = '5s';/);
  assert.match(m, /set local statement_timeout = '120s';/);
  // The lock check comes before any write.
  assert.ok(m.indexOf("from pg_locks l") < m.indexOf("update fni.rated_offers"));
  // The one write to offers sets out_of_date and nothing else.
  assert.match(m, /update fni\.rated_offers r\s+set out_of_date = false\s+from/);
  assert.equal((m.match(/^\s*update /gm) ?? []).length, 1);
  assert.doesNotMatch(m, /verification_state|verified_at|verified_snapshot|customer_price|retail_price|response_payload\s*=|selected_products/);
  // Every guard from the check is re-asserted, so a session that changed since is left alone.
  for (const g of [/r\.out_of_date\b/, /r\.request_payload->>'saleDate' = '2026-10-26'/, /s\.staff_edits->'sale_date'->>'value' = '2026-10-28'/, /s\.updated_at = timestamptz/, /from fni\.price_sheets ps/, /s\.deal_number is distinct from '14957'/]) {
    assert.match(m, g);
  }
  // One event per session changed, by System, in Jim's words.
  assert.match(m, /'Rating kept current: sale date moved within the same month \(26 Oct 2026 to 28 Oct 2026\)'/);
  assert.match(m, /'System'\s*\n\s*from kept k;/);
  // The history row.
  assert.match(m, /insert into supabase_migrations\.schema_migrations \(version, name, statements, created_by\)[\s\S]*'claude'\s*\);/);
});
