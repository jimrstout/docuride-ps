// test/service-drive.test.mjs
//
// PS sells only at the time of the vehicle sale (docs section 28). The rated
// quote is the provider's fixture; everything else is mock data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { familiesFromRows } from "../supabase/functions/_shared/rating-summary.ts";
import { isServiceDriveOption } from "../supabase/functions/_shared/service-drive.ts";
import { buildSheet } from "../supabase/functions/_shared/menu-prepare.ts";
import { buildSubmitQuote } from "../supabase/functions/_shared/offer-selections.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const QUOTE = JSON.parse(src("./fixtures/tecassured-rate-utv-3-306.json"));
const RA = { id: "prov-ra", name: "Sample Provider", kind: "Connected", adapter: "TecAssured" };
const row = { provider_id: RA.id, state: "Rated", product_count: 11, rated_at: "2026-10-31T15:00:00Z", error_detail: null, out_of_date: false, response_payload: QUOTE, provider: RA };
const RULES = [{ id: "r", tenant_id: "t", store_id: null, provider_id: null, product_code: null, cost_floor: 0, cost_ceiling: 99999,
  markup_percent: 50, markup_min_dollars: 0, markup_max_dollars: null, round_to: 0, active: true, max_markup_percent: 80, max_markup_dollars: null }];
const CATALOG = [
  ["16_3", "Mechanical Protection", "Mechanical Protection", 110], ["86_3", "Mechanical Protection, Service Drive", "Mechanical Protection", 111],
  ["84_7", "Maintenance, Platinum", "Maintenance", 103],
].map(([product_code, display_name, category, display_order]) => ({ provider_id: RA.id, product_code, display_name, category, display_order }));

test("the Service Drive Surcharge is recognised by code or name", () => {
  assert.ok(isServiceDriveOption({ code: "Service_Drive" }));
  assert.ok(isServiceDriveOption({ unique: "Service_Drive", code: "Service Drive", label: "Service Drive Surcharge" }));
  assert.ok(isServiceDriveOption({ code: "X", label: "SERVICE DRIVE SURCHARGE" }));
  for (const label of ["HVAC Equipped", "Snow Removal", "Trailer Package", "Drive Belt"]) assert.ok(!isServiceDriveOption({ code: label, label }));
});

test("the Service Drive Surcharge is never shown: not on any offer, not in the Surcharges dialog", () => {
  // The fixture carries it as optional on the maintenance plans and mandatory on a service drive plan.
  const raw = JSON.stringify(QUOTE);
  assert.ok(raw.includes('"Service_Drive"'));
  const families = familiesFromRows([row]);
  const options = families.flatMap((f) => f.tiers.flatMap((t) => t.rates.flatMap((r) => r.options)));
  assert.ok(options.length > 0);
  assert.equal(options.filter(isServiceDriveOption).length, 0);
  const sheet = buildSheet({ families, catalog: CATALOG, rules: RULES, columns: [{ name: "Gold", preset_categories: ["Mechanical Protection"], starting_level: "Highest" }],
    presets: [], prepared: null, prices: {}, surcharges: ["Service_Drive"], purchased: new Set(), purchased_prices: {} });
  assert.ok(!sheet.surcharges.available.some((s) => s.code === "Service_Drive"));
  assert.ok(!sheet.surcharges.groups.some((g) => g.items.some((i) => i.label.toLowerCase().includes("service drive"))));
  assert.deepEqual(sheet.surcharges.chosen, []);
});

test("the Service Drive Surcharge is never sent on Submit, even if a saved selection names it", () => {
  const { quote } = buildSubmitQuote(QUOTE, [{ product_unique: "84_7", rate_unique: "2192", option_uniques: ["Service_Drive"], retail_price: 1094 }]);
  assert.ok(!JSON.stringify(quote.vehicles[0].products[0].rates[0].options).includes("Service_Drive"));
});
