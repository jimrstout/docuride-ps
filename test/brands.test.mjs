// Brands: the CRM's make as one known brand, and the provider's spelling of it
// (_shared/brands.ts, migration 0056; follow-up 1 to the 2 Nov probes).
//
// Probes on deal 15063: only "Can-Am" got the full lineup; "CAN AM", "Can Am"
// and "BRP" silently lost GAP, Theft and every Mechanical Protection plan.
// Mock data only; the provider spellings follow its QA makes list's shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  brandFor, effectiveMake, makeKey, makesFromResponse, NO_GAP, NO_MECHANICAL, resolveMake, shortLineup, spellingFor,
} from "../supabase/functions/_shared/brands.ts";
import { buildVerification } from "../supabase/functions/_shared/verification.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const brand = (name, aliases = []) => ({ name, aliases, active: true });
const BRANDS = [
  brand("Can-Am"), brand("Sea-Doo"), brand("Ski-Doo"), brand("Lynx"), brand("Polaris"), brand("Indian", ["Indian Motorcycle"]),
  brand("Slingshot"), brand("Harley-Davidson"), brand("LiveWire"), brand("Yamaha", ["Yamaha Motor Corp., USA"]), brand("Kawasaki"),
];
const group = (parent_name, brand_name, vehicle_types, preferred = false) => ({ parent_name, brand_name, vehicle_types, preferred });
const GROUPS = [
  group("BRP", "Can-Am", ["ATV", "UTV", "On-Road Motorcycle"]), group("BRP", "Sea-Doo", ["Personal Watercraft"]),
  group("BRP", "Ski-Doo", ["Snowmobile"]), group("BRP", "Lynx", ["Snowmobile"]),
  group("Polaris", "Polaris", ["ATV", "UTV", "Snowmobile", "Off-Road Motorcycle"]), group("Polaris", "Slingshot", ["On-Road Motorcycle"]),
  group("Polaris", "Indian", ["On-Road Motorcycle"], true),
  group("Harley-Davidson", "Harley-Davidson", ["On-Road Motorcycle"]), group("Harley-Davidson", "LiveWire", ["On-Road Motorcycle"]),
];
const resolve = (make, vt) => resolveMake(make, vt, BRANDS, GROUPS);

test("spelling variants normalize to one brand", () => {
  for (const v of ["Can-Am", "CAN AM", "can-am", "CanAm", "Can Am", " can am. "]) {
    assert.deepEqual([resolve(v, "ATV").status, resolve(v, "ATV").brand], ["brand", "Can-Am"], v);
  }
  assert.equal(makeKey("Can-Am"), makeKey("CAN AM"));
  assert.equal(brandFor("Yamaha Motor Corp., USA", BRANDS).name, "Yamaha");
  assert.equal(brandFor("SEA DOO", BRANDS).name, "Sea-Doo");
});

test("BRP never maps alone", () => {
  for (const vt of ["ATV", "UTV", "Personal Watercraft", "Snowmobile", null]) assert.notEqual(resolve("BRP", vt).status, "brand", String(vt));
});

test("BRP on a Personal Watercraft pre-selects Sea-Doo, marked Check the brand", () => {
  const r = resolve("BRP", "Personal Watercraft");
  assert.deepEqual([r.status, r.brand, r.choices], ["check", "Sea-Doo", ["Sea-Doo"]]);
  assert.equal(r.message, 'Check the brand. The CRM says "BRP", and Sea-Doo is picked from the vehicle type. Confirm it before rating.');
});

test("BRP on a Snowmobile starts blank, narrowed to Ski-Doo and Lynx", () => {
  const r = resolve("BRP", "Snowmobile");
  assert.deepEqual([r.status, r.brand, r.choices], ["choose", null, ["Ski-Doo", "Lynx"]]);
  assert.equal(r.message, 'Pick the brand. The CRM says "BRP", which is a parent company, not a brand: choose Ski-Doo or Lynx.');
});

test("Polaris on an On-Road Motorcycle pre-selects Indian, marked Check the brand; on an ATV it is Polaris", () => {
  const r = resolve("Polaris", "On-Road Motorcycle");
  assert.deepEqual([r.status, r.brand], ["check", "Indian"]);
  assert.deepEqual(r.choices.sort(), ["Indian", "Slingshot"]);
  assert.deepEqual([resolve("Polaris", "ATV").status, resolve("Polaris", "ATV").brand], ["brand", "Polaris"]);
  // Harley-Davidson is a brand on a motorcycle, not a reason to ask.
  assert.deepEqual([resolve("HARLEY DAVIDSON", "On-Road Motorcycle").status, resolve("Harley Davidson", "On-Road Motorcycle").brand], ["brand", "Harley-Davidson"]);
  // Staff's choice stands, whatever the CRM says: confirming Polaris keeps Polaris.
  assert.deepEqual([effectiveMake("Polaris", "Polaris", "On-Road Motorcycle", BRANDS, GROUPS).brand, effectiveMake("Polaris", "Indian", "On-Road Motorcycle", BRANDS, GROUPS).status], ["Polaris", "brand"]);
});

test("an unknown make blocks rating with the plain reason", () => {
  const r = resolve("XYZ", "ATV");
  assert.deepEqual([r.status, r.brand], ["choose", null]);
  assert.equal(r.message, "Pick the brand. The CRM says 'XYZ', which doesn't match a known brand.");
});

// ── On Details: the sheet blocks until staff confirm or pick ────────────
const DEAL = (make, vehicle_type, staff_edits = null) => ({
  deal_number: "99901", unit_year: 2026, unit_make: make, unit_model: "Sample", condition: "New", vehicle_type, vehicle_type_code: null,
  odometer: 3, sale_price: 12999, finance_type: "Cash", sale_date: "2026-11-02", buyer_zip: "83702", buyer_city: "Boise", buyer_state: "ID",
  vin: "SAMPLEVIN0000001", vehicle_properties: { warranty: "12", "engine.ccs": "999" }, make_context: { brands: BRANDS, groups: GROUPS },
});
const REQUIRED = ["vin", "year", "make", "model", "new.used", "engine.ccs", "warranty", "price", "odometer", "sale.date", "postal.code"];
const edit = (value) => ({ unit_make: { value, original: null, edited_by: "JS", edited_at: "2026-11-03T09:00:00Z" } });
const makeField = (sheet) => sheet.fields.find((f) => f.key === "unit_make");

test("BRP on a Personal Watercraft blocks until confirmed", () => {
  const before = buildVerification(DEAL("BRP", "Personal Watercraft"), REQUIRED);
  const f = makeField(before);
  assert.deepEqual([f.value, f.needs_confirm, f.crm_said], ["Sea-Doo", true, "BRP"]);
  assert.match(f.problem, /^Check the brand\./);
  assert.equal(before.ready, false);
  const after = buildVerification(DEAL("BRP", "Personal Watercraft"), REQUIRED, edit("Sea-Doo"));
  assert.deepEqual([makeField(after).value, makeField(after).problem, makeField(after).edited_by, after.ready], ["Sea-Doo", null, "JS", true]);
});

test("Polaris on an On-Road Motorcycle blocks until confirmed; confirming Polaris keeps it", () => {
  const before = buildVerification(DEAL("Polaris", "On-Road Motorcycle"), REQUIRED);
  assert.deepEqual([makeField(before).value, makeField(before).needs_confirm, before.ready], ["Indian", true, false]);
  const indian = buildVerification(DEAL("Polaris", "On-Road Motorcycle"), REQUIRED, edit("Indian"));
  assert.deepEqual([makeField(indian).value, indian.ready], ["Indian", true]);
  const polaris = buildVerification(DEAL("Polaris", "On-Road Motorcycle"), REQUIRED, edit("Polaris"));
  assert.deepEqual([makeField(polaris).value, makeField(polaris).problem, polaris.ready], ["Polaris", null, true]);
});

test("BRP on a Snowmobile starts blank, and an unknown make blocks, on the sheet", () => {
  const snow = buildVerification(DEAL("BRP", "Snowmobile"), REQUIRED);
  assert.deepEqual([makeField(snow).value, makeField(snow).choices, snow.ready], [null, ["Ski-Doo", "Lynx"], false]);
  const xyz = buildVerification(DEAL("XYZ", "ATV"), REQUIRED);
  assert.equal(makeField(xyz).problem, "Pick the brand. The CRM says 'XYZ', which doesn't match a known brand.");
  assert.equal(xyz.ready, false);
  const canam = buildVerification(DEAL("CAN AM", "ATV"), REQUIRED);
  assert.deepEqual([makeField(canam).value, makeField(canam).problem, canam.ready], ["Can-Am", null, true]);
});

test("rating sends the provider's spelling; QA and live spellings stay separate", () => {
  const P = "prov-ra";
  const list = [
    { provider_id: P, environment: "Test", vtype: "MCYC", make: "Indian Motorcycle" },
    { provider_id: P, environment: "Test", vtype: "PWAC", make: "Sea Doo" },
    { provider_id: P, environment: "Live", vtype: "PWAC", make: "SEA-DOO" },
  ];
  const settled = [{ provider_id: P, environment: "Live", vtype: "MCYC", brand_name: "Indian", spelling: "INDIAN" }];
  const indian = BRANDS.find((b) => b.name === "Indian");
  const seadoo = BRANDS.find((b) => b.name === "Sea-Doo");
  assert.deepEqual(spellingFor(indian, { provider_id: P, environment: "Test", vtype: "MCYC" }, settled, list), { spelling: "Indian Motorcycle", source: "Provider list" });
  assert.deepEqual(spellingFor(indian, { provider_id: P, environment: "Live", vtype: "MCYC" }, settled, list), { spelling: "INDIAN", source: "Settled" });
  assert.deepEqual(spellingFor(seadoo, { provider_id: P, environment: "Test", vtype: "PWAC" }, settled, list), { spelling: "Sea Doo", source: "Provider list" });
  assert.deepEqual(spellingFor(seadoo, { provider_id: P, environment: "Live", vtype: "PWAC" }, settled, list), { spelling: "SEA-DOO", source: "Provider list" });
  // Nothing known for that server: the brand's own name.
  assert.deepEqual(spellingFor(seadoo, { provider_id: P, environment: "Live", vtype: "SNOW" }, settled, list), { spelling: "Sea-Doo", source: "Brand name" });
  assert.deepEqual(makesFromResponse({ vehicles: [{ make: "Can-Am", vtype: "ATV" }, { make: "", vtype: "ATV" }] }), [{ make: "Can-Am", vtype: "ATV" }]);
});

test("the safety net fires on a short financed lineup", () => {
  assert.deepEqual(shortLineup(["BAT", "PPM", "TAW", "CMB"], true), [NO_MECHANICAL, NO_GAP]);
  assert.deepEqual(shortLineup(["VSA", "GAP", "PPM"], true), []);
  assert.deepEqual(shortLineup(["BAT", "PPM"], false), [], "a cash deal has no GAP to miss");
  assert.equal(NO_MECHANICAL, "No Mechanical Protection came back. Check the brand and engine size.");
});

// ── Administration > Brands, and where the pieces meet ──────────────────
import { aliasList, parseBrand, parseGroup, parseSpelling } from "../supabase/functions/_shared/brand-admin.ts";

test("Administration checks what it saves, in plain sentences", () => {
  assert.deepEqual(aliasList("Yamaha Motor Corp., USA; Yamaha Motor Corporation;  ; Yamaha Motor Corp., USA"), ["Yamaha Motor Corp., USA", "Yamaha Motor Corporation"]);
  assert.deepEqual(parseBrand({ name: " Triumph ", aliases: "Triumph; Triumph Motorcycles", active: "on" }), { fields: { name: "Triumph", aliases: ["Triumph Motorcycles"], active: true } });
  assert.equal(parseBrand({ name: "" }).error, "Give the brand a name, such as Can-Am.");
  const names = BRANDS.map((b) => b.name);
  assert.deepEqual(parseGroup({ parent_name: "BRP", brand_name: "Lynx", vehicle_types: ["Snowmobile"] }, names).fields,
    { parent_name: "BRP", brand_name: "Lynx", vehicle_types: ["Snowmobile"], preferred: false, note: null });
  assert.equal(parseGroup({ parent_name: "BRP", brand_name: "Ducati" }, names).error, "Choose one of the brands listed.");
  assert.equal(parseGroup({ parent_name: "BRP", brand_name: "Lynx", vehicle_types: ["Hovercraft"] }, names).error, "Hovercraft is not a vehicle type.");
  assert.equal(parseGroup({ parent_name: "Polaris", brand_name: "Indian", preferred: "on" }, names).error, "A preferred brand needs the vehicle types it is preferred for.");
  const P = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(parseSpelling({ provider_id: P, environment: "Live", vtype: "mcyc", brand_name: "Indian", spelling: "Indian Motorcycle" }, names).fields,
    { provider_id: P, environment: "Live", vtype: "MCYC", brand_name: "Indian", spelling: "Indian Motorcycle", note: null });
  assert.equal(parseSpelling({ provider_id: P, environment: "Prod", vtype: "MCYC", brand_name: "Indian", spelling: "x" }, names).error, "Choose QA (Test) or live.");
});

test("the adapter refuses an unresolved make before calling the provider, and sends its spelling", () => {
  const adapter = read("supabase/functions/_shared/adapters/tecassured.ts");
  const refuse = adapter.indexOf("await providerMake(");
  assert.ok(refuse > 0 && refuse < adapter.indexOf("store.client.rateVehicle("), "the brand is settled before rating");
  assert.match(adapter, /spellingFor\(/);
  assert.match(adapter, /unit_make: branded\.make/);
  assert.match(adapter, /environment/);
});

test("Details gets the brand context, the confirm box and the safety net", () => {
  const fn = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(fn, /make_context: await brandContext\(/);
  assert.match(fn, /MAKE_CONFIRMED/);
  assert.match(fn, /shortLineup\(/);
  const page = read("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(page, /unit_make_confirmed/);
  assert.match(page, /Pick the brand/);
  assert.match(page, /Brand checked/);
  const admin = read("supabase/functions/fni-admin-settings/index.ts");
  assert.match(admin, /section === "brands"/);
  assert.doesNotMatch(read("apps/ownership-planner/app/admin/brands/page.tsx"), /—/);
});
