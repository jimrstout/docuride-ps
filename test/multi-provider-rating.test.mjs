// Multi-provider Part 4: rating across providers.
//
// One rated_offers row per provider; the menu, the save and Verify read the
// providers of the latest rating; Verify says each provider's outcome in plain
// English; a Parkersburg deal still rates with TecAssured and shows the same
// products.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeOffer } from "../supabase/functions/_shared/planner-offers.ts";
import {
  currentRows,
  familiesFromRows,
  providerLine,
  ratingSummary,
} from "../supabase/functions/_shared/rating-summary.ts";
import { rateFromSheet } from "../supabase/functions/_shared/adapters/price-sheet.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const QUOTE = JSON.parse(src("./fixtures/tecassured-rate-utv-3-306.json"));
const RA = { id: "prov-ra", name: "Riders Advantage", kind: "Connected", adapter: "TecAssured" };
const BRP = { id: "prov-brp", name: "BRP", kind: "Price Sheet", adapter: null };

const row = (provider, over = {}) => ({
  provider_id: provider.id, state: "Rated", product_count: 11, rated_at: "2026-10-17T15:00:00Z",
  error_detail: null, out_of_date: false, response_payload: QUOTE, provider, ...over,
});

const sheetOffers = rateFromSheet(
  BRP,
  { id: "sheet-1", name: "BRP 2026" },
  [{
    id: "row-1", product_code: "BRP-B3", product_name: "BRP Extended Service Terms", family_code: "BEST",
    plan: null, category: "Mechanical Protection", makes: ["Can-Am"], model_contains: [], year_min: null,
    year_max: null, vehicle_types: [], conditions: [], max_age_years: null, max_odometer: null,
    engine_cc_min: null, engine_cc_max: null, max_months_in_service: null, term_months: 36,
    term_miles: null, deductible: 50, dealer_cost: 410, suggested_retail: 699, options: [], flagged: false,
  }],
  { store_id: "pkb", make: "Can-Am", model: "Defender", year: 2026, condition: "New", vehicle_type_code: "UTV",
    odometer: 1, engine_cc: 650, sale_date: "2026-10-16", in_service_date: "2026-10-16" }
).offers;

test("a TecAssured-only rating reads back exactly as before", () => {
  const families = familiesFromRows([row(RA)]);
  // As before, less the Service Drive Surcharge, which PS never offers (_shared/service-drive.ts).
  const expected = normalizeOffer(QUOTE, { id: RA.id, name: RA.name }).map((f) => ({ ...f, tiers: f.tiers.map((t) => ({
    ...t, rates: t.rates.map((r) => ({ ...r, options: r.options.filter((o) => o.code !== "Service_Drive") })) })) }));
  assert.deepEqual(families, expected);
  assert.ok(families.flatMap((f) => f.tiers.flatMap((t) => t.rates.flatMap((r) => r.options))).every((o) => o.code !== "Service_Drive"));
  const s = ratingSummary([row(RA)]);
  assert.equal(s.state, "Rated");
  assert.equal(s.product_count, 11);
  assert.equal(s.out_of_date, false);
  assert.deepEqual(s.providers.map((p) => p.line), ["Riders Advantage: Rated, 11 products."]);
});

test("every provider's offers make one menu; a sheet row reads its own snapshot", () => {
  const families = familiesFromRows([
    row(RA),
    row(BRP, { product_count: 1, response_payload: { offers: sheetOffers, sheet_id: "sheet-1" } }),
  ]);
  assert.deepEqual(families.map((f) => `${f.provider_name}:${f.family_code}`), [
    "Riders Advantage:BAT", "BRP:BEST", "Riders Advantage:PPM", "Riders Advantage:TAW",
    "Riders Advantage:THP", "Riders Advantage:VSA",
  ]);
  const best = families.find((f) => f.family_code === "BEST");
  assert.equal(best.tiers[0].rates[0].dealer_cost, 410);
  assert.equal(best.tiers[0].rates[0].rate_unique_id, "row-1");
});

test("only the latest rating's providers count", () => {
  const rows = [row(RA), row(BRP, { state: "Rated", out_of_date: true, response_payload: { offers: sheetOffers } })];
  // The latest rating covered Riders Advantage only: BRP's old row neither adds
  // products nor holds the menu back as out of date.
  const current = currentRows(rows, ["prov-ra"]);
  assert.equal(current.length, 1);
  assert.equal(ratingSummary(current).out_of_date, false);
  // Before any rating under Part 4, every row is read.
  assert.equal(currentRows(rows, []).length, 2);
});

test("each provider's outcome in plain English", () => {
  assert.equal(providerLine(row(BRP, { state: "Failed", error_detail: "No price sheet published for BRP." })), "BRP: No price sheet published.");
  assert.equal(providerLine(row(BRP, { state: "Not Offered", product_count: 0 })), "BRP: Nothing offered for this unit.");
  assert.equal(providerLine(row(RA, { out_of_date: true })), "Riders Advantage: Out of date. Rate again.");
  assert.equal(providerLine(row(RA, { product_count: 1 })), "Riders Advantage: Rated, 1 product.");
});

test("not offered only when every provider said so; any failure stays neutral", () => {
  const notOffered = row(BRP, { state: "Not Offered", product_count: 0 });
  const failed = row(RA, { state: "Failed", product_count: 0, error_detail: "Rating failed: timeout" });
  assert.equal(ratingSummary([notOffered]).state, "Not Offered");
  assert.equal(ratingSummary([notOffered, failed]).state, "Failed");
  assert.equal(ratingSummary([notOffered, row(RA)]).state, "Rated");
  assert.equal(ratingSummary([]).state, "Pending");
  assert.equal(
    ratingSummary([notOffered, failed]).detail,
    "BRP: Nothing offered for this unit. Riders Advantage: Rating failed: timeout"
  );
});

test("rating goes through the template, every provider in parallel, one row each", () => {
  const rs = src("../supabase/functions/_shared/rate-session.ts");
  assert.match(rs, /const template = chooseTemplate\(templates,/);
  assert.match(rs, /return \{ template: null, providers: all\.filter\(\(p\) => p\.adapter === "TecAssured"\) \};/);
  assert.match(rs, /providers\.map\(\(p\) => rateOne\(/);
  assert.match(rs, /if \(provider\.adapter === "TecAssured"\)/);
  assert.match(rs, /rateFromSheet\(offerProvider, sheet, rates, deal\)/);

  const rate = src("../supabase/functions/fni-rate-vehicle/index.ts");
  assert.match(rate, /menu_template_id: template\?\.id \?\? null,/);
  assert.match(rate, /rated_provider_ids: outcomes\.map\(\(o\) => o\.provider\.id\),/);
  // The caller's contract is unchanged: product_count on success, an error otherwise.
  assert.match(rate, /product_count: productCount,/);
});

test("the menu, the save and Verify read the latest rating's providers", () => {
  const get = src("../supabase/functions/fni-session-get/index.ts");
  assert.match(get, /currentRows\(\s*\(await offerRowsFor\(supabase, sessionId\)\)/);
  assert.match(get, /familiesFromRows\(rows\)/);
  assert.match(get, /\.in\("provider_id", offeredProviders\)/);
  const save = src("../supabase/functions/fni-session-save/index.ts");
  assert.match(save, /familiesFromRows\(offers\)/);
  assert.match(save, /"rated_provider_ids",/);
  const verify = src("../supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /const menu = await menuFor\(supabase, s\.tenant_id as string, deal\);/);
  assert.match(verify, /\[\.\.\.new Set\(\[\.\.\.taProperties, \.\.\.sheetInputs\.flat\(\)\]\)\]/);
  assert.match(verify, /menu_template: menu\.template \? \{ name: menu\.template\.name \} : null,/);
});

test("the migration is additive and backfills from existing rows", () => {
  const sql = src("../supabase/migrations/0024_rated_providers.sql");
  assert.doesNotMatch(sql, /\bdrop\b/i);
  assert.match(sql, /add column if not exists rated_provider_ids uuid\[\] not null default '\{\}'/);
  assert.match(sql, /from fni\.rated_offers/);
});
