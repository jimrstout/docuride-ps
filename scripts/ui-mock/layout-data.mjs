// scripts/ui-mock/layout-data.mjs: a full menu for the layout check.
//
// Seven rows (every category a menu can hold after migration 0054), four
// columns, and the longest plan names and option labels the catalog has, so
// the check measures the worst case. Built by the real sheet code
// (_shared/menu-prepare.ts). Made-up figures only.

import { buildSheet, preparedForMenu } from "../../supabase/functions/_shared/menu-prepare.ts";

const P = "p0";
const rate = (id, months, cost, deductible = 100, dis = true) => ({
  rate_unique_id: id, term_months: months, term_miles: 0, deductible, deductible_code: null, disappearing_deductible: dis,
  dealer_cost: cost, provider_markup: 0, offered_price: null, options: [], raw: {}, retail_price: Math.round(cost * 1.5),
});
const PLANS = [
  ["Mechanical Protection", "VSA", [["MP-1", "Mechanical Protection, Premium Plus 13-24"], ["MP-2", "Mechanical Protection, Care Plus 1-12"], ["MP-3", "Mechanical Protection"]]],
  ["Maintenance", "PPM", [["PM-4", "Priority Maintenance, Platinum"], ["PM-3", "Priority Maintenance, Gold"], ["PM-2", "Priority Maintenance, Silver"], ["PM-1", "Priority Maintenance, Bronze"]]],
  ["Tire and Wheel", "TAW", [["TW-1", "Tire and Wheel Protection"]]],
  ["Theft", "THP", [["TH-2", "Theft Protection, Plan B"], ["TH-1", "Theft Protection, Plan A"]]],
  ["Battery", "BAT", [["BA-2", "Battery Protection, Plus"], ["BA-1", "Battery Protection, Standard"]]],
  ["GAP", "GAP", [["GAP-1", "GAP"]]],
  ["Wear Care", "CMB", [["WC-1", "Wear Care"]]],
];
let n = 0;
export const FAMILIES = PLANS.map(([, ptype, tiers]) => ({
  family_code: ptype, provider_id: P, provider_name: "Mock Provider",
  tiers: tiers.map(([code, name]) => ({
    product_code: code, product_name: name.toUpperCase(), product_type: ptype, provider_id: P, raw: {},
    rates: [rate(`r${++n}`, 48, 400 + n * 7), rate(`r${++n}`, 60, 480 + n * 7)],
  })),
}));
export const CATALOG = PLANS.flatMap(([category, , tiers]) =>
  tiers.map(([code, name], i) => ({ provider_id: P, product_code: code, display_name: name, category, display_order: 100 + i })));
const ALL = PLANS.map(([c]) => c);
const COLUMNS = [
  { name: "Platinum", preset_categories: ALL, starting_level: "Highest" },
  { name: "Gold", preset_categories: ALL, starting_level: "Middle" },
  { name: "Silver", preset_categories: ALL, starting_level: "Middle" },
  { name: "Bronze", preset_categories: ALL, starting_level: "Lowest" },
];

export const SHEET = buildSheet({
  families: FAMILIES, catalog: CATALOG, rules: [], columns: COLUMNS, presets: [],
  prepared: null, prices: {}, surcharges: [], purchased: new Set(), purchased_prices: {},
  terms: { "1": [{ months: 72, rate: 7.49 }], "2": [], "3": [], "4": [] },
});

/** What fni-menu-prepare answers for the layout deal. */
export function preparePayload(id) {
  return {
    session: { id, deal_number: "99902", vehicle: "2026 Mockmake Outlander Backcountry 1000R", prepared_at: null, prepared_by: null, locked_at: null },
    out_of_date: false,
    payment: { has_payment: true, principal: 18935.95, rate: 6.3847, term_months: 60, cap: null, financed: true },
    sheet: SHEET,
    service_drive_lines: [],
  };
}

/** The menu's offers and catalog for the layout deal, in fni-session-get's shape. */
export function menuParts() {
  return {
    families: FAMILIES.map((f) => ({ ...f, tiers: f.tiers.map((t) => ({ ...t, available: true })) })),
    catalog: CATALOG.map((c) => ({
      ...c, goal: "Keep ownership manageable", what_it_accomplishes: "Made-up wording.", what_it_covers: "Made-up wording.",
      coverage_duration: "The term shown with your price.", what_it_excludes: null, deductible_note: null, how_to_use: null,
      transferable: false, transfer_note: null, future_value_note: null, full_terms_url: null, relevance_tags: [], store_id: null, is_presentable: true,
    })),
    menu_columns: COLUMNS,
    menu_prepared: preparedForMenu(SHEET),
  };
}
