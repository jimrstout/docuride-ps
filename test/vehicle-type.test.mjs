// The vehicle type on Verify: seven choices stored as shown, picked by one
// rule, mapped to what TecAssured has always been sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  crmVehicleType,
  looksOffRoad,
  pickVehicleType,
  resolveVehicleType,
  TECASSURED_VTYPE,
  VEHICLE_TYPES,
  vehicleTypeForCode,
  vtypeForBodyType,
} from "../supabase/functions/_shared/vehicle-types.ts";
import { chooseTemplate } from "../supabase/functions/_shared/menu-templates.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("seven choices, stored exactly as shown", () => {
  assert.deepEqual([...VEHICLE_TYPES], [
    "ATV", "UTV", "On-Road Motorcycle", "Off-Road Motorcycle", "Personal Watercraft", "Snowmobile", "Other",
  ]);
  const sql = src("../supabase/migrations/0031_session_vehicle_type.sql");
  assert.match(sql, /'ATV', 'UTV', 'On-Road Motorcycle', 'Off-Road Motorcycle',\s*'Personal Watercraft', 'Snowmobile', 'Other'/);
  assert.doesNotMatch(sql, /\bdrop\b/i);
});

test("what TecAssured is sent is unchanged for UTV and motorcycles", () => {
  for (const body of ["SxS", "ATV Off Road", "Street Motorcycle", "3 Wheel Motorcycle", "Motorcycle Off Road", "Motocross Off Road", "PWCs", "Snowmobile"]) {
    const picked = crmVehicleType({ Sold_1_Body_Type: body, Sold_1_Model: "Something 900" });
    assert.equal(picked.vehicle_type_code, vtypeForBodyType(body), body);
  }
  assert.equal(TECASSURED_VTYPE["On-Road Motorcycle"], "MCYC");
  assert.equal(TECASSURED_VTYPE["Off-Road Motorcycle"], "BIKE");
  assert.equal(TECASSURED_VTYPE.Other, null);
});

test("MCYC is On-Road unless the model clearly marks an off-road bike", () => {
  for (const m of ["KX250", "CRF450R", "YZ125", "RM-Z450", "KLX300", "TC 125", "250 SX-F", "EXC 300", "FC 350", "WR250F"]) {
    assert.ok(looksOffRoad(m), m);
  }
  for (const m of ["Vulcan® 900 Classic", "Ninja 1000SX", "FXDR 114", "Z900", "Road Glide", "Duke 390", "MT-07"]) {
    assert.ok(!looksOffRoad(m), m);
  }
  // Deal 13437: a Vulcan 900, a street bike.
  assert.deepEqual(
    pickVehicleType({ body_type: "Street Motorcycle", make: "Kawasaki", model: "Vulcan® 900 Classic", decoded_vtype: "MCYC" }),
    { type: "On-Road Motorcycle", source: "Picked from the CRM body type Street Motorcycle. Change it if that is wrong." }
  );
  assert.equal(pickVehicleType({ body_type: "Street Motorcycle", make: "Honda", model: "CRF450R", decoded_vtype: null }).type, "Off-Road Motorcycle");
  assert.equal(pickVehicleType({ body_type: null, make: "Kawasaki", model: "Vulcan 900", decoded_vtype: "MCYC" }).type, "On-Road Motorcycle");
  assert.equal(pickVehicleType({ body_type: "Trailer", make: null, model: null, decoded_vtype: null }).type, "Other");
});

test("existing sessions convert from their code: UTV to UTV, MCYC to On-Road Motorcycle", () => {
  assert.equal(vehicleTypeForCode("UTV"), "UTV");
  assert.equal(vehicleTypeForCode("MCYC"), "On-Road Motorcycle");
  assert.equal(vehicleTypeForCode("BIKE"), "Off-Road Motorcycle");
  const sql = src("../supabase/migrations/0031_session_vehicle_type.sql");
  assert.match(sql, /when 'MCYC' then 'On-Road Motorcycle'/);
  assert.match(sql, /'Converted on 26 Oct 2026 from the stored code ' \|\| vehicle_type_code/);
  // A stored session reads its converted choice and the line that says so.
  const r = resolveVehicleType({ vehicle_type: "On-Road Motorcycle", vehicle_type_source: "Converted on 26 Oct 2026 from the stored code MCYC. Change it if that is wrong." });
  assert.equal(r.type, "On-Road Motorcycle");
  assert.match(r.line, /^Converted on 26 Oct 2026/);
});

test("the menu template is matched on the vehicle type as staff see it", () => {
  const t = (over) => ({ id: "t", name: "t", store_ids: [], deal_types: [], vehicle_types: [], conditions: [], makes: [], priority: 0, active: true, updated_at: "2026-10-26T00:00:00Z", ...over });
  const templates = [
    t({ id: "all", name: "All deals" }),
    t({ id: "road", name: "On-Road Motorcycle", vehicle_types: ["On-Road Motorcycle"] }),
    t({ id: "dirt", name: "Off-Road Motorcycle", vehicle_types: ["Off-Road Motorcycle"] }),
  ];
  const deal = (vehicle_type) => ({ store_id: "s", deal_type: "Loan", vehicle_type, condition: "Used", make: "Kawasaki" });
  assert.equal(chooseTemplate(templates, deal("On-Road Motorcycle")).id, "road");
  assert.equal(chooseTemplate(templates, deal("Off-Road Motorcycle")).id, "dirt");
  assert.equal(chooseTemplate(templates, deal("Snowmobile")).id, "all");
  // Rating and Verify resolve the vehicle type the same way.
  const rs = src("../supabase/functions/_shared/rate-session.ts");
  assert.match(rs, /vehicle_type: resolveVehicleType\(src\)\.type,/);
  assert.match(rs, /vehicle_type: deal\.vehicle_type \?\? null,/);
});

test("Verify shows the choice first in the Vehicle panel, and a change needs Confirm and Continue", () => {
  const ver = src("../supabase/functions/_shared/verification.ts");
  assert.ok(ver.indexOf('key: "vehicle_type", label: "Vehicle type"') < ver.indexOf('key: "vin", label: "VIN"'));
  const page = src("../apps/ownership-planner/app/verify/[sessionId]/page.tsx");
  assert.match(page, /<VehicleTypeChoice value=\{field\.value\} line=\{editedLine \?\? field\.note\} edited=\{edited\} \/>/);
  assert.match(page, /`Entered by Staff: /);
  const choice = src("../apps/ownership-planner/components/VehicleTypeChoice.tsx");
  assert.match(choice, /type="radio" name="vehicle_type"/);
  assert.match(choice, /closest\("form"\)\?\.requestSubmit\(\)/);
  // The two lists agree.
  for (const v of VEHICLE_TYPES) assert.match(choice, new RegExp(`"${v}"`));
});
