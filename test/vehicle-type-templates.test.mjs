// The menu for each vehicle type (migration 0033). TecAssured refuses an
// On-Road product on an off-road bike and the reverse, at contract time, so
// the On-Road and Off-Road menus must never share a vehicle-specific product.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chooseTemplate } from "../supabase/functions/_shared/menu-templates.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const SQL = src("../supabase/migrations/0033_vehicle_type_menu_templates.sql");

/** The seeded slots per template, read out of the migration. */
function seeded() {
  const out = {};
  for (const m of SQL.matchAll(/\('([^']+)', (\d), '([^']+)',\s+'([^']+)',\s+array\[([^\]]+)\]\)/g)) {
    (out[m[1]] ??= []).push({ position: Number(m[2]), title: m[3], codes: m[5].split(",").map((c) => c.trim().replace(/'/g, "")) });
  }
  return out;
}

// Vehicle-specific products by version, as TecAssured names them.
const ON_ROAD = ["62_7", "77_7", "71_7", "83_7", "22_4", "14_3", "88_3", "2058_141", "2066_141"];
const OFF_ROAD_MC = ["1619_7", "1616_7", "1618_7", "1617_7"];
const UTV_ATV = ["66_7", "78_7", "72_7", "84_7", "16_3", "86_3", "2060_141", "2064_141"];
const EVERY_VEHICLE = ["24_5", "25_5", "755_6", "754_6"];

test("each template holds exactly the products in the brief, in the All deals order", () => {
  const s = seeded();
  const codes = (name) => s[name].flatMap((x) => x.codes);
  assert.deepEqual(s["ATV and UTV"].map((x) => x.title), ["Maintenance", "Mechanical Protection", "Tire and Wheel", "Theft", "Battery"]);
  assert.deepEqual(s["On-Road Motorcycle"].map((x) => x.title), ["Maintenance", "Mechanical Protection", "Tire and Wheel", "Theft", "Battery"]);
  // No off-road motorcycle Care was offered on the test deals, so no slot.
  assert.deepEqual(s["Off-Road Motorcycle"].map((x) => x.title), ["Maintenance", "Tire and Wheel", "Theft", "Battery"]);
  assert.deepEqual(codes("ATV and UTV").sort(), [...UTV_ATV, "23_4", ...EVERY_VEHICLE].sort());
  assert.deepEqual(codes("On-Road Motorcycle").sort(), [...ON_ROAD, ...EVERY_VEHICLE].sort());
  assert.deepEqual(codes("Off-Road Motorcycle").sort(), [...OFF_ROAD_MC, "23_4", ...EVERY_VEHICLE].sort());
});

test("never an Off-Road product on an On-Road vehicle, or the reverse", () => {
  const s = seeded();
  const road = new Set(s["On-Road Motorcycle"].flatMap((x) => x.codes));
  const dirt = new Set(s["Off-Road Motorcycle"].flatMap((x) => x.codes));
  for (const c of [...OFF_ROAD_MC, "23_4", ...UTV_ATV]) assert.ok(!road.has(c), `${c} on the On-Road menu`);
  for (const c of [...ON_ROAD, ...UTV_ATV]) assert.ok(!dirt.has(c), `${c} on the Off-Road menu`);
});

test("each vehicle type gets its own menu; everything else falls back to All deals", () => {
  const t = (id, vehicle_types, priority) => ({ id, name: id, store_ids: [], deal_types: [], vehicle_types, conditions: [], makes: [], priority, active: true, updated_at: "2026-10-26T00:00:00Z" });
  const templates = [
    t("All deals", [], 0),
    t("ATV and UTV", ["ATV", "UTV"], 10),
    t("On-Road Motorcycle", ["On-Road Motorcycle"], 10),
    t("Off-Road Motorcycle", ["Off-Road Motorcycle"], 10),
  ];
  const pick = (vehicle_type) => chooseTemplate(templates, { store_id: "s", deal_type: "Loan", vehicle_type, condition: "Used", make: "Kawasaki" }).id;
  assert.equal(pick("UTV"), "ATV and UTV");
  assert.equal(pick("ATV"), "ATV and UTV");
  assert.equal(pick("On-Road Motorcycle"), "On-Road Motorcycle");
  assert.equal(pick("Off-Road Motorcycle"), "Off-Road Motorcycle");
  assert.equal(pick("Snowmobile"), "All deals");
  assert.match(SQL, /array\['ATV', 'UTV'\]\)/);
  assert.doesNotMatch(SQL, /\bdrop\b|delete from/i);
});
