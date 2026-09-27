// The Verify sheet: what it shows, where it says values came from, and when it
// will let somebody press Verify.
//
// The gate matters more than the screen. The button being disabled and the
// endpoint refusing are the same computation on purpose, so these tests are
// really about `ready`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerification,
  changedInputs,
  dealTypeLabel,
  ratingInputs,
  STAFF_ENTERED,
} from "../supabase/functions/_shared/verification.ts";

/** What /rate/requiredproperties returns for UTV at dealer 3-306. Verbatim. */
const UTV = [
  "vin", "fuel.type", "year", "make", "model", "new.used", "engine.ccs",
  "finance.type", "finance.amount", "finance.apr", "finance.term", "odometer",
  "price", "sale.date", "inservice.date", "Warranty", "postal.code",
];

/** Deal 14132 as fni.sessions actually holds it. A real cash deal. */
const defender = (over = {}) => ({
  deal_number: "14132", stock_number: "30111", finance_type: "Cash",
  sale_date: "2026-09-26",
  vin: "3JBUKAJ44TK002241", unit_year: 2026, unit_make: "Can-Am",
  unit_model: "Defender XT HD7", condition: "New", vehicle_type_code: "UTV",
  odometer: 1, in_service_date: "2026-09-26",
  sale_price: "16899", amount_financed: "19764.64", finance_term: null, apr: null,
  buyer_city: "Barboursville", buyer_state: "WV", buyer_zip: "25504",
  vehicle_properties: null,
  vin_decode: null,
  ...over,
});

/** The verbatim /decode/ps response for that VIN, tested 2026-09-26. */
const DECODE = {
  year: "2026", make: "Can-Am", model: "Defender",
  displacement: "650", vtype: "UTV", fuelType: "G",
};

const sheet = (over = {}) => buildVerification(defender(over), UTV);
const byKey = (s) => Object.fromEntries(s.fields.map((f) => [f.key, f]));

// ── What the Defender is missing, and in what order it stops missing it ────

test("a fresh cash deal is missing exactly the three fields nothing carries", () => {
  const s = sheet();
  assert.deepEqual(s.missing.map((f) => f.key).sort(), [
    "engine.ccs", "fuel.type", "warranty",
  ]);
  assert.equal(s.ready, false);
});

test("the VIN decode answers two of the three", () => {
  const s = sheet({ vin_decode: DECODE });
  assert.deepEqual(s.missing.map((f) => f.key), ["warranty"]);
  assert.equal(s.ready, false);

  const f = byKey(s);
  assert.equal(f["engine.ccs"].value, "650");
  assert.equal(f["engine.ccs"].source, "VIN Decode");
  assert.equal(f["fuel.type"].value, "G");
  assert.equal(f["fuel.type"].source, "VIN Decode");
});

test("warranty months is the one field a person must type", () => {
  const s = sheet({ vin_decode: DECODE, vehicle_properties: { warranty: "6" } });
  assert.deepEqual(s.missing, []);
  assert.equal(s.ready, true);

  const f = byKey(s);
  assert.equal(f.warranty.value, "6");
  assert.equal(f.warranty.source, "Entered by Staff");
  assert.equal(f.warranty.editable, true);
});

test("a typed engine size beats the decode, and says so", () => {
  const s = sheet({
    vin_decode: DECODE,
    vehicle_properties: { warranty: "6", "engine.ccs": "976" },
  });
  const f = byKey(s);
  assert.equal(f["engine.ccs"].value, "976");
  assert.equal(f["engine.ccs"].source, "Entered by Staff");
});

// ── The CRM owns what the CRM owns ────────────────────────────────────────

// ── Every rating input is editable (2026-09-27) ───────────────────────────
//
// These two tests used to assert the opposite: that every CRM field was
// read-only and that exactly three fields could be typed. That was the rule
// until Jim replaced it. The rule now is that everything feeding a rate is
// editable and the two identifiers are not, so that is what is asserted.

test("every field that feeds a rate is editable", () => {
  const s = sheet({ vin_decode: DECODE });
  for (const f of s.fields) {
    // Not rating inputs: the two that identify the deal, and the lender, which
    // is shown so staff can confirm who is financing it. Deal type is the field
    // that decides how the deal rates, and that one is editable.
    if (["deal_number", "stock_number", "lender"].includes(f.key)) continue;
    // The three finance figures close on a cash deal, and this fixture is one.
    if (["amount_financed", "finance_term", "apr"].includes(f.key)) continue;
    assert.equal(f.editable, true, `${f.key} must be editable`);
  }
});

test("only the fields that feed no rate are never editable", () => {
  // Was "only the two that identify the deal". Lender joined them when the sheet
  // started reading the finance figures from the same source as the planner: it
  // is displayed for confirmation, and a lienholder is attached in CRM.
  const locked = sheet({ vin_decode: DECODE, finance_type: "Loan" })
    .fields.filter((f) => !f.editable);
  assert.deepEqual(
    locked.map((f) => f.key).sort(),
    ["deal_number", "lender", "stock_number"]
  );
  // None of the three is a TecAssured rating input, so changing one cannot
  // invalidate a verification.
  for (const f of locked) assert.equal(f.provider_property, null, f.key);
});

test("a CRM field no longer tells you to go and fix it in CRM", () => {
  // The old note was "Correct this in CRM, then click Refresh." It is wrong now:
  // you can correct it right here.
  const s = sheet({ vin_decode: DECODE });
  for (const f of s.fields) {
    if (f.note) assert.doesNotMatch(f.note, /Correct this in CRM/);
  }
  assert.match(byKey(s).sale_price.note, /Edit it here/);
});

test("the finance figures stay shut on a cash deal, and open on a loan", () => {
  // Letting somebody type $19,000 into a cash deal is exactly how 14132 would
  // have told the provider a cash buyer financed twenty thousand dollars.
  const cash = byKey(sheet({ vin_decode: DECODE }));
  assert.equal(cash.amount_financed.editable, false);
  assert.equal(cash.apr.editable, false);
  assert.match(cash.apr.note, /Change the deal type to edit it/);

  const loan = byKey(sheet({ vin_decode: DECODE, finance_type: "Loan" }));
  assert.equal(loan.amount_financed.editable, true);
  assert.equal(loan.apr.editable, true);
});

// ── A cash deal's finance figures are facts, not gaps ─────────────────────

test("a cash deal shows zeros rather than Missing for the finance fields", () => {
  const f = byKey(sheet({ vin_decode: DECODE }));
  assert.equal(f.amount_financed.value, "$0.00");
  assert.equal(f.finance_term.value, "0");
  assert.equal(f.apr.value, "0%");
  for (const k of ["amount_financed", "finance_term", "apr"]) {
    assert.equal(f[k].source, "CRM");
    assert.equal(f[k].missing, false);
  }
});

test("a leftover amount_financed is not shown on a cash deal", () => {
  // 14132 carries 19,764.64 with no lienholder. Showing it would have a person
  // reconciling a number that should not exist.
  assert.equal(byKey(sheet()).amount_financed.value, "$0.00");
});

test("a financed deal shows its real figures and flags a missing APR", () => {
  const s = buildVerification(
    defender({ finance_type: "Loan", amount_financed: "19764.64", finance_term: 60, apr: null }),
    UTV
  );
  const f = byKey(s);
  assert.equal(f.amount_financed.value, "$19,764.64");
  assert.equal(f.finance_term.value, "60");
  assert.equal(f.apr.source, "Missing");
  assert.ok(s.missing.some((m) => m.key === "apr"));
});

// ── Deal type reads in words staff use ────────────────────────────────────

test("deal type is Cash, Finance or Lease", () => {
  assert.equal(dealTypeLabel("Cash"), "Cash");
  assert.equal(dealTypeLabel("Loan"), "Finance");
  assert.equal(dealTypeLabel("Lease"), "Lease");
  assert.equal(dealTypeLabel("None"), "Cash");
  assert.equal(dealTypeLabel(null), null);
});

// ── Not knowing what is needed is not the same as being ready ─────────────

test("an empty required list is never ready", () => {
  // A cold properties cache, or an unmapped vehicle type. Every field could be
  // full and we still do not know what the provider wants.
  const s = buildVerification(
    defender({ vin_decode: DECODE, vehicle_properties: { warranty: "6" } }),
    []
  );
  assert.equal(s.ready, false);
  assert.deepEqual(s.missing, []);
});

test("a required property with no field on the screen blocks verification", () => {
  const s = buildVerification(
    defender({ vin_decode: DECODE, vehicle_properties: { warranty: "6" } }),
    [...UTV, "trailer.axles"]
  );
  assert.deepEqual(s.unmapped_properties, ["trailer.axles"]);
  assert.equal(s.ready, false, "a field nobody can fill in cannot be ready");
});

test("the casing TecAssured uses does not change what is required", () => {
  // `warranty` for ATV and MCYC, `Warranty` for UTV and BIKE. Same field.
  const lower = buildVerification(defender({ vin_decode: DECODE }), UTV.map((p) => p.toLowerCase()));
  assert.ok(lower.missing.some((f) => f.key === "warranty"));
  assert.deepEqual(lower.unmapped_properties, []);
});

// ── The vehicle type falls back to the provider's own opinion ─────────────

test("an unmapped body type takes the vehicle type from the decode", () => {
  const f = byKey(sheet({ vehicle_type_code: null, vin_decode: DECODE }));
  assert.equal(f.vehicle_type_code.value, "UTV");
  assert.equal(f.vehicle_type_code.source, "VIN Decode");
});

// ── What a refresh counts as a change ─────────────────────────────────────

test("only fields that feed the rate are compared", () => {
  const inputs = ratingInputs(sheet({ vin_decode: DECODE }));
  // Stock number is on the screen and is not a rating input.
  assert.ok(!("stock_number" in inputs));
  assert.ok("sale_price" in inputs);
  assert.ok("engine.ccs" in inputs);
});

test("a changed sale price is a change and a changed stock number is not", () => {
  const before = ratingInputs(sheet({ vin_decode: DECODE }));

  const priceMoved = ratingInputs(
    buildVerification(defender({ vin_decode: DECODE, sale_price: "17499" }), UTV)
  );
  assert.deepEqual(changedInputs(before, priceMoved), ["sale_price"]);

  const stockMoved = ratingInputs(
    buildVerification(defender({ vin_decode: DECODE, stock_number: "30999" }), UTV)
  );
  assert.deepEqual(changedInputs(before, stockMoved), []);
});

test("no prior snapshot means everything counts as changed", () => {
  const after = ratingInputs(sheet({ vin_decode: DECODE }));
  assert.equal(changedInputs(null, after).length, Object.keys(after).length);
});

test("a value that changed and came back is not a change", () => {
  const a = ratingInputs(sheet({ vin_decode: DECODE }));
  const b = ratingInputs(sheet({ vin_decode: DECODE }));
  assert.deepEqual(changedInputs(a, b), []);
});

// ── The customer's details stop at the ZIP ────────────────────────────────

test("the sheet carries no name, street, phone or email", () => {
  const keys = sheet({ vin_decode: DECODE }).fields.map((f) => f.key);
  for (const forbidden of [
    "buyer_first_name", "buyer_last_name", "buyer_display_name",
    "buyer_address", "buyer_phone", "buyer_email",
  ]) {
    assert.ok(!keys.includes(forbidden), `${forbidden} must not be on a staff sheet`);
  }
  assert.deepEqual(
    sheet({ vin_decode: DECODE }).fields.filter((f) => f.group === "Customer").map((f) => f.key),
    ["buyer_city", "buyer_state", "buyer_zip"]
  );
});

// ── House style ──────────────────────────────────────────────────────────

test("nothing on the sheet uses an em dash", () => {
  for (const f of sheet({ vin_decode: DECODE }).fields) {
    for (const s of [f.label, f.note, f.source, f.value]) {
      if (typeof s === "string") {
        assert.ok(!/[—–]/.test(s), `em dash in ${JSON.stringify(s)}`);
      }
    }
  }
});

test("the states read as words", () => {
  const s = sheet({ vin_decode: DECODE });
  const sources = new Set(s.fields.map((f) => f.source));
  for (const v of sources) {
    assert.ok(
      ["CRM", "DX1", "VIN Decode", "Entered by Staff", "Missing"].includes(v),
      `unexpected source ${v}`
    );
  }
});
