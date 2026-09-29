// Engine size: a decoded displacement reaches the rate request, not only the
// Verify sheet.
//
// Before this, the sheet read staff then the VIN decode, and the rate request
// read staff only. A deal whose engine size came from the decode passed Verify
// and was then refused for missing engine.ccs. Both now share resolveEngineCc.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEngineCc } from "../supabase/functions/_shared/engine-size.ts";
import { buildVerification } from "../supabase/functions/_shared/verification.ts";
import { buildRateRequest } from "../supabase/functions/_shared/rate-request.ts";
import { parseRequiredProperties } from "../supabase/functions/_shared/rate-properties.ts";
import { applyStaffEdits } from "../supabase/functions/_shared/staff-edits.ts";

/** What /rate/requiredproperties returns for UTV at dealer 3-306. */
const UTV = [
  "vin", "fuel.type", "year", "make", "model", "new.used", "engine.ccs",
  "finance.type", "finance.amount", "finance.apr", "finance.term", "odometer",
  "price", "sale.date", "inservice.date", "Warranty", "postal.code",
];

/** Deal 14132, a real cash deal, with warranty typed and no engine size. */
const deal = (over = {}) => ({
  deal_number: "14132", stock_number: "30111", finance_type: "Cash",
  sale_date: "2026-09-26",
  vin: "3JBUKAJ44TK002241", unit_year: 2026, unit_make: "Can-Am",
  unit_model: "Defender XT HD7", condition: "New", vehicle_type_code: "UTV",
  odometer: 1, in_service_date: "2026-09-26",
  sale_price: "16899", amount_financed: "19764.64", finance_term: null, apr: null,
  buyer_city: "Barboursville", buyer_state: "WV", buyer_zip: "25504",
  vehicle_properties: { warranty: "6" },
  vin_decode: null,
  ...over,
});

/** The verbatim /decode/ps response for that VIN. */
const DECODE = {
  year: "2026", make: "Can-Am", model: "Defender",
  displacement: "650", vtype: "UTV", fuelType: "G",
};

const built = (session) =>
  buildRateRequest(
    parseRequiredProperties(UTV.map((name) => ({ name }))).properties,
    session,
    { dealerCode: "3-306", vtype: "UTV", rateDate: "2026-09-26" }
  );

const arrayEngine = (req) => req.properties.find((p) => p.name === "engine.ccs")?.value;

test("staff value wins over the decode, and neither means none", () => {
  assert.deepEqual(resolveEngineCc(null, DECODE), { value: "650", source: "VIN Decode" });
  assert.deepEqual(resolveEngineCc({ "engine.ccs": "976" }, DECODE),
    { value: "976", source: "Entered by Staff" });
  // Either stored name, either case, as the rate request has always read it.
  assert.deepEqual(resolveEngineCc({ Displacement: "999" }, null),
    { value: "999", source: "Entered by Staff" });
  assert.equal(resolveEngineCc({ "engine.ccs": "  " }, null), null);
  assert.equal(resolveEngineCc(null, { displacement: "" }), null);
  assert.equal(resolveEngineCc(null, null), null);
});

test("a decoded engine size reaches both halves of the rate request", () => {
  const { request, missing } = built(deal({ vin_decode: DECODE }));
  assert.deepEqual(missing, [], "nothing is missing once the decode answers");
  assert.equal(request.displacement, "650");
  assert.equal(arrayEngine(request), "650");
});

test("a staff value beats the decode in both halves", () => {
  const { request } = built(deal({
    vin_decode: DECODE,
    vehicle_properties: { warranty: "6", "engine.ccs": "976" },
  }));
  assert.equal(request.displacement, "976");
  assert.equal(arrayEngine(request), "976");
});

test("a staff edit over the decode reaches the request through applyStaffEdits", () => {
  // The path fni-rate-vehicle takes: the row with the staff layer applied.
  const edits = {
    "engine.ccs": {
      value: "976", original: "650", original_source: "VIN Decode",
      edited_by: "Jim", edited_at: "2026-09-29T12:00:00Z",
    },
  };
  const { request } = built(applyStaffEdits(deal({ vin_decode: DECODE }), edits));
  assert.equal(request.displacement, "976");
  assert.equal(arrayEngine(request), "976");
});

test("with neither, engine size is still missing and the rate is refused", () => {
  const { request, missing } = built(deal());
  assert.deepEqual(missing.map((m) => m.name), ["engine.ccs"]);
  assert.equal("displacement" in request, false, "no invented number is sent");
});

test("the sheet and the rate request never disagree", () => {
  for (const over of [
    { vin_decode: DECODE },
    { vehicle_properties: { warranty: "6", "engine.ccs": "976" } },
    { vehicle_properties: { warranty: "6", "engine.ccs": "976" }, vin_decode: DECODE },
    {},
  ]) {
    const session = deal(over);
    const field = buildVerification(session, UTV).fields.find((f) => f.key === "engine.ccs");
    const { request } = built(session);
    assert.equal(field.value ?? undefined, request.displacement, JSON.stringify(over));
    assert.equal(field.value ?? undefined, arrayEngine(request), JSON.stringify(over));
  }
});
