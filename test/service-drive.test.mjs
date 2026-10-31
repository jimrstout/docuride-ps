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

// ── Service drive plans ──────────────────────────────────────────────────

import { pointOfSale } from "../supabase/functions/_shared/rating-summary.ts";
import { isServiceDriveName, isServiceDrivePlan } from "../supabase/functions/_shared/service-drive.ts";
import { parsePresets, CATEGORIES } from "../supabase/functions/_shared/menu-presets.ts";

const P = "prov-1";
const mrate = (id, months, cost, options = []) => ({ rate_unique_id: id, term_months: months, term_miles: 0, deductible: 0, deductible_code: null,
  disappearing_deductible: false, dealer_cost: cost, provider_markup: 0, offered_price: null, options, raw: {}, retail_price: cost * 1.5 });
const mtier = (code, name, rates, raw = {}) => ({ product_code: code, product_name: name, product_type: "VSA", provider_id: P, rates, raw });
const SD_MAND = { code: "Service_Drive", label: "Service Drive Surcharge", cost_delta: 0, mandatory: true, applied: false };
// As the provider sends them: the Care pair carry the surcharge, the Premium pair only the name.
const MOCK = () => [{ family_code: "VSA", provider_id: P, provider_name: "Sample", tiers: [
  mtier("C-1", "SAMPLE CARE", [mrate("c12", 12, 300)]),
  mtier("C-SD", "SAMPLE CARE-SVC DRIVE", [mrate("d12", 12, 900, [SD_MAND])], { blurb: "SAMPLE CARE - SERVICE DRIVE" }),
  mtier("P-1", "SAMPLE PREMIUM", [mrate("p12", 12, 500)]),
  mtier("P-SD", "SAMPLE PREMIUM CARE-SVC DRIVE", [mrate("q12", 12, 1200)], { blurb: "SAMPLE CARE - SERVICE DRIVE" }),
] }];
const MOCK_CATALOG = [
  ["C-1", "Mechanical Protection", 110], ["C-SD", "Mechanical Protection, Service Drive", 111],
  ["P-1", "Mechanical Protection, Premium", 112], ["P-SD", "Mechanical Protection, Premium Service Drive", 113],
].map(([product_code, display_name, display_order]) => ({ provider_id: P, product_code, display_name, category: "Mechanical Protection", display_order }));
const COLS = [
  { name: "Platinum", preset_categories: ["Mechanical Protection"], starting_level: "Highest" },
  { name: "Gold", preset_categories: ["Mechanical Protection"], starting_level: "Middle" },
];
const preset = (pos, plan_name) => ({ column_position: pos, category: "Mechanical Protection", provider_id: null, plan_name, term_months: 12,
  term_miles: null, deductible: null, disappearing_deductible: null });
const mockSheet = (presets = []) => buildSheet({ families: pointOfSale(MOCK()), catalog: MOCK_CATALOG, rules: RULES, columns: COLS, presets,
  prepared: null, prices: {}, surcharges: [], purchased: new Set(), purchased_prices: {} });

test("a service drive plan is known by its name, or by a Service Drive Surcharge it must carry", () => {
  for (const n of ["USED ATV/UTV CARE-SVC DRIVE - RIDERS ADVANTAGE CARE COVERAGE", "Mechanical Protection, Premium Service Drive", "SERVICE-DRIVE CARE"]) assert.ok(isServiceDriveName(n), n);
  for (const n of ["USED ATV/UTV CARE - RIDERS ADVANTAGE CARE COVERAGE", "Mechanical Protection, Premium", "Drive Belt Care", "Service Plan"]) assert.ok(!isServiceDriveName(n), n);
  assert.ok(isServiceDrivePlan({ product_name: "SAMPLE", raw: {}, rates: [{ options: [SD_MAND] }] }));
  assert.ok(isServiceDrivePlan({ product_name: "SAMPLE", raw: { blurb: "SAMPLE CARE - SERVICE DRIVE" }, rates: [] }));
  // Optional on a maintenance plan, it does not make the plan a service drive plan.
  assert.ok(!isServiceDrivePlan({ product_name: "SAMPLE PPM", raw: {}, rates: [{ options: [{ ...SD_MAND, mandatory: false }] }] }));
});

test("service drive plans are never offered: not in the rating as read, not on Prepare menu", () => {
  // The provider's fixture: USED ATV/UTV CARE-SVC DRIVE (86_3) is gone, its point-of-sale twin stays.
  const codes = familiesFromRows([row]).flatMap((f) => f.tiers.map((t) => t.product_code));
  assert.ok(!codes.includes("86_3"));
  assert.ok(codes.includes("16_3"));
  const sheet = mockSheet();
  assert.deepEqual(sheet.plans["Mechanical Protection"].map((p) => p.plan_name), ["Mechanical Protection", "Mechanical Protection, Premium"]);
  // The level rule picks by price, and the costliest plans were the service drive ones: no longer.
  const plan = (pos) => Object.values(sheet.plans).flat().find((p) => p.options.some((o) => o.key === sheet.cells[pos]["Mechanical Protection"].key)).plan_name;
  assert.equal(plan("1"), "Mechanical Protection, Premium");
  assert.ok(!JSON.stringify(sheet).includes("Service Drive"));
});

test("a preset naming a service drive plan falls back, with a plain note, and the preset is left as saved", () => {
  const presets = [preset(1, "Mechanical Protection, Premium Service Drive"), preset(2, "Mechanical Protection, Service Drive")];
  const sheet = mockSheet(presets);
  assert.equal(sheet.cells["1"]["Mechanical Protection"].note, "Preset plan is for service drive sales only; using Mechanical Protection, Premium instead.");
  assert.equal(sheet.cells["2"]["Mechanical Protection"].note, "Preset plan is for service drive sales only; using Mechanical Protection instead.");
  assert.equal(presets[0].plan_name, "Mechanical Protection, Premium Service Drive");
  // Nothing below it offered: said plainly.
  const none = buildSheet({ families: pointOfSale(MOCK()).map((f) => ({ ...f, tiers: f.tiers.filter((t) => t.product_code === "P-1") })), catalog: MOCK_CATALOG,
    rules: RULES, columns: COLS, presets: [preset(1, "Mechanical Protection, Service Drive")], prepared: null, prices: {}, surcharges: [], purchased: new Set(), purchased_prices: {} });
  assert.equal(none.cells["1"]["Mechanical Protection"].note, "Preset plan is for service drive sales only, and no other plan is offered here.");
});

test("the preset pickers leave service drive plans out, and saving one is refused", () => {
  const admin = src("../supabase/functions/fni-admin-settings/templates.ts");
  assert.match(admin, /products\.filter\(\(p\) => p\.category === c && !isServiceDriveName\(p\.name\)\)/);
  const ci = CATEGORIES.indexOf("Mechanical Protection");
  const names = new Set(MOCK_CATALOG.map((c) => c.display_name));
  const got = parsePresets({ [`p_1_${ci}_plan`]: "Mechanical Protection, Premium Service Drive" }, 2, names);
  assert.deepEqual(got.errors, ["Column 1, Mechanical Protection: Mechanical Protection, Premium Service Drive is for service drive sales only. Choose another plan."]);
  assert.ok("presets" in parsePresets({ [`p_1_${ci}_plan`]: "Mechanical Protection, Premium" }, 2, names));
  // A saved one stays visible in the picker, marked, so it is never cleared silently.
  const page = src("../apps/ownership-planner/app/admin/menus/page.tsx");
  assert.match(page, /\{p\.plan_name\} \(not offered: choose another\)/);
});

// ── A selection already on a service drive plan ──────────────────────────

import { SERVICE_DRIVE_EVENT, isServiceDriveQuoteProduct, serviceDriveLine, serviceDriveSelections } from "../supabase/functions/_shared/service-drive.ts";

test("a saved selection on a service drive plan is found, named as the catalog names it, and not changed", () => {
  const catalog = { "C-SD": "Mechanical Protection, Service Drive", "P-SD": "Mechanical Protection, Premium Service Drive", "C-1": "Mechanical Protection" };
  const rows = [
    { provider_product_id: "C-SD", product_name: "Mechanical Protection, Service Drive", disposition: "Included" },
    { provider_product_id: "P-SD", product_name: "SAMPLE PREMIUM CARE-SVC DRIVE", disposition: "Included" },
    // Declined: nothing to submit, nothing to say.
    { provider_product_id: "C-SD", product_name: "Mechanical Protection, Service Drive", disposition: "Managed by Customer" },
    { provider_product_id: "C-1", product_name: "Mechanical Protection", disposition: "Included" },
    // Known only by the surcharge its saved rate had to carry.
    { provider_product_id: "X-9", product_name: "SAMPLE CARE", disposition: "Included", rate_snapshot: { options: [{ unique: "Service_Drive", mandatory: true }] } },
  ];
  const before = JSON.stringify(rows);
  assert.deepEqual(serviceDriveSelections(rows, catalog), [
    { code: "C-SD", name: "Mechanical Protection, Service Drive" },
    { code: "P-SD", name: "Mechanical Protection, Premium Service Drive" },
    { code: "X-9", name: "SAMPLE CARE" },
  ]);
  assert.equal(JSON.stringify(rows), before);
  assert.equal(serviceDriveLine("Mechanical Protection, Service Drive"),
    "Mechanical Protection, Service Drive is a service drive plan and cannot be submitted.");
});

test("Submit refuses a service drive plan with the same words and a session event, before anything is sent", () => {
  // The provider's fixture: 86_3 is USED ATV/UTV CARE-SVC DRIVE.
  assert.ok(isServiceDriveQuoteProduct(QUOTE, "86_3"));
  assert.ok(!isServiceDriveQuoteProduct(QUOTE, "16_3"));
  assert.ok(!isServiceDriveQuoteProduct(QUOTE, "84_7"));
  const submit = src("../supabase/functions/fni-contract-submit/index.ts");
  const step = submit.slice(submit.indexOf("// ── Step 4a: Never a service drive plan"), submit.indexOf("// And every one must have a dealer cost"));
  assert.match(step, /serviceDriveLine\(sdNames\[r\.providerProductId\] \?\? r\.productName\)/);
  assert.match(step, /event: SERVICE_DRIVE_EVENT,\s*detail: \{ products: serviceDrive\.map\(\(x\) => x\.code\) \}/);
  assert.match(step, /return await refuse\(409, \{ error: `Nothing was sent\. \$\{serviceDrive\.map\(\(x\) => x\.line\)\.join\(" "\)\}`/);
  // Logs carry the session and a count only.
  assert.match(step, /console\.warn\("fni-contract-submit stopped: service drive plan", \{ session: session_id, products: serviceDrive\.length \}\)/);
  // Before the quote is cut down and sent.
  assert.ok(submit.indexOf("Step 4a: Never a service drive plan") < submit.indexOf("const { quote: submitQuote } = buildSubmitQuote("));
  assert.equal(SERVICE_DRIVE_EVENT, "Submit stopped: a service drive plan cannot be submitted");
});

test("Details and Prepare menu show the same plain line", () => {
  const verify = src("../supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /service_drive_lines: await serviceDriveLines\(supabase, s\.id as string\)/);
  const prep = src("../supabase/functions/fni-menu-prepare/index.ts");
  assert.match(prep, /service_drive_lines: serviceDrive,/);
  const details = src("../apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(details, /\(sheet\.service_drive_lines \?\? \[\]\)\.map\(\(line\) => \(\s*<p key=\{line\} className="console-flash console-flash--bad" role="alert">\{line\}<\/p>/);
  const screen = src("../apps/ownership-planner/app/prepare/[sessionId]/Prepare.tsx");
  assert.match(screen, /\(data\.service_drive_lines \?\? \[\]\)\.map\(\(line\) => \(\s*<p key=\{line\} className="pm-note pm-note--bad" role="alert">\{line\}<\/p>/);
});
