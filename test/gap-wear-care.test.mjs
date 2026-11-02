// GAP and Wear Care have menu rows of their own (migration 0054): deal 15063's
// stored rating shows both rows, and the "offered but no menu row uses it"
// notes for them are gone. The fixture copies 15063's 22:57 rating's product
// list (codes, provider types and names, read only); the prices are made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { familiesFromRows } from "../supabase/functions/_shared/rating-summary.ts";
import { resolveSlots, unplacedOffers } from "../supabase/functions/_shared/menu-templates.ts";
import { buildSheet } from "../supabase/functions/_shared/menu-prepare.ts";
import { CATEGORIES } from "../supabase/functions/_shared/menu-presets.ts";
import { CATEGORIES as PROVIDER_CATEGORIES } from "../supabase/functions/_shared/providers.ts";
import { categoryForType } from "../supabase/functions/_shared/product-category.ts";

const P = "prov-ra";
const OFFERED_15063 = [
  ["26_6", "BAT", "RA BATTERY STANDARD - RIDERS ADVANTAGE BATTERY"],
  ["27_6", "BAT", "RA BATTERY PLUS - RIDERS ADVANTAGE BATTERY"],
  ["1029_46", "CMB", "ATV/UTV - RIDERS ADVANTAGE WEAR CARE"],
  ["18_2", "GAP", "POWERSPORTS GAP 150% - RIDERS ADVANTAGE GAP"],
  ["54_7", "PPM", "NEW BRONZE ATV/OFF-ROAD MC - RIDERS ADVANTAGE PPM"],
  ["55_7", "PPM", "NEW SILVER ATV/OFF-ROAD MC - RIDERS ADVANTAGE PPM"],
  ["56_7", "PPM", "NEW GOLD ATV/OFF-ROAD MC - RIDERS ADVANTAGE PPM"],
  ["57_7", "PPM", "NEW PLATINUM ATV/OFF-ROAD MC - RIDERS ADVANTAGE PPM"],
  ["23_4", "TAW", "RIDER'S ADVANTAGE T&W OFF-ROAD - RIDERS ADVANTAGE TIRE & WHEEL"],
  ["24_5", "THP", "RA THEFT PLAN A - RIDERS ADVANTAGE THEFT"],
  ["25_5", "THP", "RA THEFT PLAN B - RIDERS ADVANTAGE THEFT"],
  ["2072_142", "VSA", "NEW ATV/UTV PREMIUM PLUS 1-12 - RIDERS ADVANTAGE PREMIUM PLUS"],
  ["2088_142", "VSA", "NEW ATV/UTV PREMIUM PLUS 13-24 - RIDERS ADVANTAGE PREMIUM PLUS"],
  ["2092_142", "VSA", "NEW ATV/UTV PREMIUM PLUS 25-36 - RIDERS ADVANTAGE PREMIUM PLUS"],
  ["3_1", "VSA", "NEW ATV/UTV CARE PLUS 1-12 - RIDERS ADVANTAGE CARE PLUS COVERAGE"],
];
let n = 0;
const row = {
  provider_id: P, state: "Rated", product_count: OFFERED_15063.length, rated_at: "2026-11-02T22:57:31Z", error_detail: null, out_of_date: false,
  provider: { id: P, name: "Mock Provider", kind: "API", adapter: "TecAssured" },
  request_payload: { remainingMWM: "12" },
  response_payload: { quote: { vehicles: [{ products: OFFERED_15063.map(([unique, ptype, label]) => ({
    unique, ptype, label,
    rates: [{ unique: `r${++n}`, termMonths: 60, termMiles: 0, dealerCost: { amount: 200 + n, currency: "USD" }, providerMarkup: { adjustment: { amount: 0 } }, dealerDeduct: { amount: 0 }, attributes: {}, options: [] }],
  })) }] } },
};

// The catalog as migrations 0052 and 0054 leave it, and the ATV and UTV menu's rows.
const CAT = [
  ["c-54", "54_7", "Maintenance"], ["c-55", "55_7", "Maintenance"], ["c-56", "56_7", "Maintenance"], ["c-57", "57_7", "Maintenance"],
  ["c-3", "3_1", "Mechanical Protection"], ["c-2072", "2072_142", "Mechanical Protection"],
  ["c-2088", "2088_142", "Mechanical Protection"], ["c-2092", "2092_142", "Mechanical Protection"],
  ["c-23", "23_4", "Tire and Wheel"], ["c-24", "24_5", "Theft"], ["c-25", "25_5", "Theft"],
  ["c-26", "26_6", "Battery"], ["c-27", "27_6", "Battery"], ["c-gap", "18_2", "GAP"], ["c-wear", "1029_46", "Wear Care"],
];
const CATALOG = new Map(CAT.map(([id, code]) => [id, { provider_id: P, product_code: code }]));
const slot = (position, title, ids) => ({ id: `s${position}`, template_id: "t", position, title, category: title, mode: "Side by Side", product_ids: ids });
const ATV_UTV = [
  slot(1, "Maintenance", ["c-54", "c-55", "c-56", "c-57"]),
  slot(2, "Mechanical Protection", ["c-3", "c-2072", "c-2088", "c-2092"]),
  slot(3, "Tire and Wheel", ["c-23"]),
  slot(4, "Theft", ["c-24", "c-25"]),
  slot(5, "Battery", ["c-26", "c-27"]),
  slot(6, "GAP", ["c-gap"]),
  slot(7, "Wear Care", ["c-wear"]),
];

test("15063's stored rating shows GAP and Wear Care rows, and no note for them", () => {
  const families = familiesFromRows([row]);
  const resolved = resolveSlots(ATV_UTV, families, CATALOG);
  const byTitle = Object.fromEntries(resolved.map((r) => [r.title, r]));
  assert.deepEqual(byTitle.GAP.tiers.map((t) => t.tier.product_code), ["18_2"]);
  assert.deepEqual(byTitle["Wear Care"].tiers.map((t) => t.tier.product_code), ["1029_46"]);
  assert.equal(byTitle.GAP.hidden, false);
  assert.deepEqual(unplacedOffers(resolved, families), []);
  // Warranty bands at 12 months: only the 1-12 Mechanical Protection plans.
  assert.deepEqual(byTitle["Mechanical Protection"].tiers.map((t) => t.tier.product_code).sort(), ["2072_142", "3_1"]);
});

test("Prepare presentation has a GAP row and a Wear Care row", () => {
  const sheet = buildSheet({
    families: familiesFromRows([row]),
    catalog: CAT.map(([, code, category], i) => ({ provider_id: P, product_code: code, display_name: code, category, display_order: i })),
    rules: [], columns: [{ name: "Platinum", preset_categories: [], starting_level: "Highest" }], presets: [],
    prepared: null, prices: {}, surcharges: [], purchased: new Set(), purchased_prices: {},
  });
  assert.deepEqual(sheet.categories, ["Mechanical Protection", "Maintenance", "Tire and Wheel", "Theft", "Battery", "GAP", "Wear Care"]);
});

test("GAP and Wear Care are categories everywhere the list is kept", () => {
  for (const list of [CATEGORIES, PROVIDER_CATEGORIES]) {
    assert.ok(list.includes("GAP") && list.includes("Wear Care"));
  }
  for (const page of ["apps/ownership-planner/app/admin/menus/page.tsx", "apps/ownership-planner/app/admin/price-sheets/[sheetId]/page.tsx"]) {
    assert.match(readFileSync(new URL(`../${page}`, import.meta.url), "utf8"), /"Battery", "GAP", "Wear Care", "Appearance", "Other"/);
  }
  // The provider's own types: a GAP or Wear Care product the catalog lacks still lands in its row.
  assert.equal(categoryForType("GAP"), "GAP");
  assert.equal(categoryForType("CMB"), "Wear Care");
  const sql = readFileSync(new URL("../supabase/migrations/0054_gap_and_wear_care_categories.sql", import.meta.url), "utf8");
  assert.equal((sql.match(/drop constraint/g) ?? []).length, 3, "only the three approved DROPs");
});
