// Priority Maintenance reaches the Maintenance row, and nothing offered is
// ever silently dropped.
//
// Deal 15063: the provider offered four Priority Maintenance plans (PPM:
// Platinum, Gold, Silver, Bronze) under its codes for a used ATV, 64_7, 69_7,
// 75_7 and 81_7. The ATV and UTV menu's Maintenance row lists the UTV codes
// (66_7, 72_7, 78_7, 84_7), and the catalog had no row for the ATV ones, so
// the offers matched nothing and the row vanished from Prepare presentation.
// A contract for one would have been called "Product" by the DX1 check.
//
// The fixture below copies 15063's stored rating's product list as read from
// the database (codes, provider types and names; read only, no customer
// data). The prices are made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { familiesFromRows } from "../supabase/functions/_shared/rating-summary.ts";
import { resolveSlots, unplacedOffers } from "../supabase/functions/_shared/menu-templates.ts";
import { categoryForType, categoryFromWording, categoryOf, unplacedNote } from "../supabase/functions/_shared/product-category.ts";
import { expectedSlot, productName } from "../supabase/functions/_shared/dx1-check.ts";
import { detailsSource, verifySource } from "./details-source.mjs";

const P = "prov-ra";
/** 15063's offered products: [code, ptype, name]. */
const OFFERED_15063 = [
  ["754_6", "BAT", "RA BATTERY PLUS USED - RIDERS ADVANTAGE BATTERY"],
  ["755_6", "BAT", "RA BATTERY STANDARD USED - RIDERS ADVANTAGE BATTERY"],
  ["64_7", "PPM", "USED BRONZE ATV - RIDERS ADVANTAGE PPM"],
  ["69_7", "PPM", "USED GOLD ATV - RIDERS ADVANTAGE PPM"],
  ["75_7", "PPM", "USED PLATINUM ATV - RIDERS ADVANTAGE PPM"],
  ["81_7", "PPM", "USED SILVER ATV - RIDERS ADVANTAGE PPM"],
  ["23_4", "TAW", "RIDER'S ADVANTAGE T&W OFF-ROAD - RIDERS ADVANTAGE TIRE & WHEEL"],
  ["24_5", "THP", "RA THEFT PLAN A - RIDERS ADVANTAGE THEFT"],
  ["25_5", "THP", "RA THEFT PLAN B - RIDERS ADVANTAGE THEFT"],
  ["16_3", "VSA", "USED ATV/UTV CARE - RIDERS ADVANTAGE CARE COVERAGE"],
  ["2060_141", "VSA", "USED ATV/UTV CARE - RIDERS ADVANTAGE PREMIUM"],
  ["2064_141", "VSA", "USED ATV/UTV CARE-SVC DRIVE - RIDERS ADVANTAGE PREMIUM"],
  ["86_3", "VSA", "USED ATV/UTV CARE-SVC DRIVE - RIDERS ADVANTAGE CARE COVERAGE"],
];

function ratingRow(products) {
  let n = 0;
  const rate = (months) => ({
    unique: `r${++n}`, termMonths: months, termMiles: 0,
    dealerCost: { amount: 300 + n * 10, currency: "USD" }, providerMarkup: { adjustment: { amount: 0 } },
    dealerDeduct: { amount: 0 }, attributes: {}, options: [],
  });
  return {
    provider_id: P, state: "Rated", product_count: products.length, rated_at: "2026-11-02T13:38:37Z",
    error_detail: null, out_of_date: false,
    provider: { id: P, name: "Mock Provider", kind: "API", adapter: "TecAssured" },
    response_payload: { quote: { vehicles: [{ products: products.map(([unique, ptype, label]) => ({ unique, ptype, label, rates: [rate(12), rate(24)] })) }] } },
  };
}

/** The ATV and UTV menu's rows as the database has them, and the catalog rows they list. */
const CATALOG = new Map([
  ["c-bronze-utv", { provider_id: P, product_code: "66_7" }], ["c-gold-utv", { provider_id: P, product_code: "72_7" }],
  ["c-silver-utv", { provider_id: P, product_code: "78_7" }], ["c-plat-utv", { provider_id: P, product_code: "84_7" }],
  ["c-mp", { provider_id: P, product_code: "16_3" }], ["c-mp-prem", { provider_id: P, product_code: "2060_141" }],
  ["c-mp-prem-sd", { provider_id: P, product_code: "2064_141" }], ["c-mp-sd", { provider_id: P, product_code: "86_3" }],
  ["c-tw", { provider_id: P, product_code: "23_4" }], ["c-theft-a", { provider_id: P, product_code: "24_5" }],
  ["c-theft-b", { provider_id: P, product_code: "25_5" }], ["c-bat-plus", { provider_id: P, product_code: "754_6" }],
  ["c-bat-std", { provider_id: P, product_code: "755_6" }],
]);
const slot = (position, title, product_ids) => ({ id: `s${position}`, template_id: "t", position, title, category: title, mode: "Side by Side", product_ids });
const ATV_UTV = [
  slot(1, "Maintenance", ["c-bronze-utv", "c-gold-utv", "c-plat-utv", "c-silver-utv"]),
  slot(2, "Mechanical Protection", ["c-mp", "c-mp-prem", "c-mp-prem-sd", "c-mp-sd"]),
  slot(3, "Tire and Wheel", ["c-tw"]),
  slot(4, "Theft", ["c-theft-a", "c-theft-b"]),
  slot(5, "Battery", ["c-bat-plus", "c-bat-std"]),
];

test("15063's rating produces a Maintenance row with its four Priority Maintenance plans", () => {
  const families = familiesFromRows([ratingRow(OFFERED_15063)]);
  const resolved = resolveSlots(ATV_UTV, families, CATALOG);
  const maintenance = resolved.find((r) => r.title === "Maintenance");
  assert.equal(maintenance.hidden, false);
  assert.deepEqual(maintenance.tiers.map((t) => t.tier.product_code).sort(), ["64_7", "69_7", "75_7", "81_7"]);
  // Every other row as before, and nothing offered left unplaced.
  assert.deepEqual(resolved.map((r) => [r.title, r.tiers.length]), [
    ["Maintenance", 4], ["Mechanical Protection", 2], ["Tire and Wheel", 1], ["Theft", 2], ["Battery", 2],
  ]);
  assert.deepEqual(unplacedOffers(resolved, families), []);
});

test("service drive versions stay out on a regular sale, even by category", () => {
  const families = familiesFromRows([ratingRow(OFFERED_15063)]);
  const codes = families.flatMap((f) => f.tiers.map((t) => t.product_code));
  assert.ok(!codes.includes("2064_141") && !codes.includes("86_3"), "never offered at the point of sale");
  // A Mechanical Protection row listing only the service drive codes falls
  // back by category, and still takes only the point-of-sale plans.
  const onlySd = [slot(2, "Mechanical Protection", ["c-mp-prem-sd", "c-mp-sd"])];
  const r = resolveSlots(onlySd, families, CATALOG)[0];
  assert.deepEqual(r.tiers.map((t) => t.tier.product_code).sort(), ["16_3", "2060_141"]);
  for (const t of r.tiers) assert.doesNotMatch(t.tier.product_name, /SVC DRIVE/);
});

test("a product type no row uses becomes a plain note on Details, never silence", () => {
  const families = familiesFromRows([ratingRow(OFFERED_15063)]);
  // A menu with no Maintenance row: the four plans are said, not dropped.
  const noMaintenance = ATV_UTV.filter((s) => s.title !== "Maintenance");
  const resolved = resolveSlots(noMaintenance, families, CATALOG);
  assert.deepEqual(unplacedOffers(resolved, families), ["4 Maintenance plans were offered but no menu row uses them."]);
  // A type this app has no word for is named by its own type.
  const odd = familiesFromRows([ratingRow([["900_9", "GAP", "RA GAP - RIDERS ADVANTAGE GAP"]])]);
  assert.deepEqual(unplacedOffers(resolveSlots(ATV_UTV, odd, CATALOG), odd), ["1 GAP plan was offered but no menu row uses it."]);
  assert.equal(unplacedNote("Maintenance", 2), "2 Maintenance plans were offered but no menu row uses them.");
});

test("every provider type the ratings return has a category", () => {
  // PPM, VSA, TAW, THP and BAT: every type in every stored rating (2026-11-02).
  assert.equal(categoryForType("PPM"), "Maintenance");
  assert.equal(categoryForType("VSA"), "Mechanical Protection");
  assert.equal(categoryForType("TAW"), "Tire and Wheel");
  assert.equal(categoryForType("THP"), "Theft");
  assert.equal(categoryForType("BAT"), "Battery");
  assert.equal(categoryForType("XYZ"), null);
  // The catalog's word wins when it has one.
  assert.equal(categoryOf({ catalog: "Appearance", ptype: "PPM" }), "Appearance");
  assert.equal(categoryOf({ catalog: null, ptype: "PPM" }), "Maintenance");
});

test("a Priority Maintenance contract is Maintenance to the DX1 check, never Product", () => {
  const name = "USED BRONZE ATV - RIDERS ADVANTAGE PPM";
  assert.equal(categoryFromWording(name), "Maintenance");
  const c = { contract_number: "C-1", category: categoryFromWording(name), product_name: name, plan: "USED BRONZE ATV", term_months: 24, cents: 50000 };
  assert.equal(expectedSlot(c), "PPM");
  assert.equal(productName(c), "Maintenance");
  // Even read with no category at all, its name says what it is.
  assert.equal(productName({ ...c, category: null }), "Maintenance");
  const fn = readFileSync(new URL("../supabase/functions/fni-dx1-check/index.ts", import.meta.url), "utf8");
  assert.match(fn, /category: cat\.get\(`\$\{r\.provider_id\}:\$\{r\.provider_product_id\}`\) \?\? categoryFromWording\(r\.product_name\),/);
});

test("Details shows the note", () => {
  const verify = verifySource();
  assert.match(verify, /unplaced_offers: resolved \? unplacedOffers\(resolved, familiesFromRows\(rows\)\) : \[\],/);
  const page = detailsSource();
  assert.match(page, /\(sheet\.unplaced_offers \?\? \[\]\)\.map\(\(line\) => \(/);
});

test("Prepare presentation files an uncatalogued plan under its own row, never Other", async () => {
  // Before migration 0048 the catalog had no row for 15063's ATV codes, and
  // Prepare called them "Other". The provider's type now decides.
  const { buildSheet } = await import("../supabase/functions/_shared/menu-prepare.ts");
  const families = familiesFromRows([ratingRow(OFFERED_15063)]);
  const sheet = buildSheet({
    families, catalog: [], rules: [], columns: [{ name: "Best", preset_categories: ["Maintenance"], starting_level: "Highest" }],
    presets: [], prepared: null, prices: {}, surcharges: [], purchased: new Set(), purchased_prices: {},
  });
  assert.ok(sheet.categories.includes("Maintenance"));
  assert.ok(!sheet.categories.includes("Other"));
  assert.deepEqual(sheet.plans.Maintenance.map((p) => p.product_code).sort(), ["64_7", "69_7", "75_7", "81_7"]);
  for (const p of sheet.plans["Mechanical Protection"]) assert.doesNotMatch(p.plan_name, /SVC DRIVE/);
  // The acknowledgment matches a removed row the same way.
  const ack = readFileSync(new URL("../supabase/functions/fni-acknowledgment/index.ts", import.meta.url), "utf8");
  assert.match(ack, /catOf\.get\(`\$\{d\.provider_id as string\}:\$\{code\}`\) \|\| categoryFromWording\(d\.product_name\) \|\| ""/);
});
