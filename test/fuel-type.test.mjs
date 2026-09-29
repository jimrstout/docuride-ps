// Fuel type: the Gasoline default, the automatic VIN decode, and the dropdown.
//
// The sheet and the rate request used to answer fuel type separately and could
// disagree, and the two halves of the rate request could carry different values
// for it ("Gas" in the array, "G" at the top level). These pin the one
// resolution both now share, and the page behaviour around decoding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_FUEL_TYPE,
  FUEL_TYPES,
  fuelChoice,
  fuelCodeFor,
  fuelWord,
  resolveFuelType,
} from "../supabase/functions/_shared/fuel-type.ts";
import { buildVerification } from "../supabase/functions/_shared/verification.ts";
import { buildRateRequest } from "../supabase/functions/_shared/rate-request.ts";
import { parseRequiredProperties } from "../supabase/functions/_shared/rate-properties.ts";
import { applyStaffEdits, castForProperty, editTargetFor } from "../supabase/functions/_shared/staff-edits.ts";
import { FUEL_TYPE_CHOICES, ratingInputsFrom } from "../apps/ownership-planner/lib/verify-fields.ts";
import {
  AUTO_DECODE_TIMEOUT_MS,
  decodeDidNotAnswer,
  shouldAutoDecode,
} from "../apps/ownership-planner/lib/auto-decode.ts";

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

/** What /rate/requiredproperties returns for UTV at dealer 3-306. */
const UTV = [
  "vin", "fuel.type", "year", "make", "model", "new.used", "engine.ccs",
  "finance.type", "finance.amount", "finance.apr", "finance.term", "odometer",
  "price", "sale.date", "inservice.date", "Warranty", "postal.code",
];

/** Deal 14132, a real cash deal, with the two fields a person must supply. */
const deal = (over = {}) => ({
  deal_number: "14132", stock_number: "30111", finance_type: "Cash",
  sale_date: "2026-09-26",
  vin: "3JBUKAJ44TK002241", unit_year: 2026, unit_make: "Can-Am",
  unit_model: "Defender XT HD7", condition: "New", vehicle_type_code: "UTV",
  odometer: 1, in_service_date: "2026-09-26",
  sale_price: "16899", amount_financed: "19764.64", finance_term: null, apr: null,
  buyer_city: "Barboursville", buyer_state: "WV", buyer_zip: "25504",
  vehicle_properties: { "engine.ccs": "650", warranty: "6" },
  vin_decode: null,
  ...over,
});

const fuelField = (session) =>
  buildVerification(session, UTV).fields.find((f) => f.key === "fuel.type");

const request = (session) =>
  buildRateRequest(
    parseRequiredProperties(UTV.map((name) => ({ name }))).properties,
    session,
    { dealerCode: "3-306", vtype: "UTV", rateDate: "2026-09-26" }
  ).request;

const arrayFuel = (req) => req.properties.find((p) => p.name === "fuel.type").value;

// ── Resolution order ─────────────────────────────────────────────────────

test("staff choice wins over the VIN decode, which wins over the default", () => {
  assert.deepEqual(resolveFuelType(null, null), { value: "Gasoline", source: "Default" });
  assert.deepEqual(resolveFuelType(null, { fuelType: "D" }), { value: "Diesel", source: "VIN Decode" });
  assert.deepEqual(
    resolveFuelType({ "fuel.type": "Electric" }, { fuelType: "D" }),
    { value: "Electric", source: "Entered by Staff" }
  );
  // A stored value that is not a fuel type is passed over, not trusted.
  assert.deepEqual(resolveFuelType({ "fuel.type": "Hydrogen" }, { fuelType: "E" }),
    { value: "Electric", source: "VIN Decode" });
  assert.equal(DEFAULT_FUEL_TYPE, "Gasoline");
});

test("the sheet resolves the same way, and a staff edit beats the decode", () => {
  assert.equal(fuelField(deal()).source, "Default");
  assert.equal(fuelField(deal({ vin_decode: { fuelType: "D" } })).value, "Diesel");
  assert.equal(fuelField(deal({ vin_decode: { fuelType: "D" } })).source, "VIN Decode");

  // A dropdown choice arrives as a staff edit, applied over the decode.
  const edits = {
    "fuel.type": {
      value: "Electric", original: "Diesel", original_source: "VIN Decode",
      edited_by: "Jim", edited_at: "2026-09-29T12:00:00Z",
    },
  };
  const f = buildVerification(deal({ vin_decode: { fuelType: "D" } }), UTV, edits)
    .fields.find((x) => x.key === "fuel.type");
  assert.equal(f.value, "Electric");
  assert.equal(f.source, "Edited by Staff");
});

test("an edit over the default reads as entered, not as a correction", () => {
  const edits = {
    "fuel.type": {
      value: "Diesel", original: "Gasoline", original_source: "Default",
      edited_by: "Jim", edited_at: "2026-09-29T12:00:00Z",
    },
  };
  const f = buildVerification(deal(), UTV, edits).fields.find((x) => x.key === "fuel.type");
  assert.equal(f.value, "Diesel");
  assert.equal(f.source, "Entered by Staff");
});

// ── The Default source ───────────────────────────────────────────────────

test("the Default source is not Missing and does not block Confirm", () => {
  const sheet = buildVerification(deal(), UTV);
  const f = sheet.fields.find((x) => x.key === "fuel.type");
  assert.equal(f.value, "Gasoline");
  assert.equal(f.source, "Default");
  assert.equal(f.required, true);
  assert.equal(f.missing, false);
  assert.ok(!sheet.missing.some((x) => x.key === "fuel.type"));
  assert.equal(sheet.ready, true, "a deal with only the default for fuel can be confirmed");
});

test("Default is a FieldSource on both sides", () => {
  assert.match(src("../supabase/functions/_shared/verification.ts"), /\| "Default"/);
  assert.match(src("../apps/ownership-planner/lib/types.ts"), /\| "Default"/);
});

// ── Words, not codes ─────────────────────────────────────────────────────

test("older stored codes display as words", () => {
  for (const [stored, word] of [
    ["G", "Gasoline"], ["Gas", "Gasoline"], ["gasoline", "Gasoline"],
    ["E", "Electric"], ["D", "Diesel"],
  ]) {
    assert.equal(fuelWord(stored), word);
    assert.equal(fuelField(deal({ vehicle_properties: { "fuel.type": stored } })).value, word);
    assert.equal(fuelField(deal({ vin_decode: { fuelType: stored } })).value, word);
  }
  assert.equal(fuelWord("Hydrogen"), null);
  assert.equal(fuelWord(""), null);
});

// ── The rate request ─────────────────────────────────────────────────────

test("the rate request sends the same code at the top level and in the array", () => {
  const cases = [
    [{ vehicle_properties: { "fuel.type": "Gasoline" } }, "G"],
    [{ vehicle_properties: { "fuel.type": "Electric" } }, "E"],
    [{ vehicle_properties: { "fuel.type": "Diesel" } }, "D"],
    // The default, with nothing stored and no decode.
    [{ vehicle_properties: {} }, "G"],
    // From the decode, which the request used to ignore.
    [{ vehicle_properties: {}, vin_decode: { fuelType: "D" } }, "D"],
    // An older stored word the array used to receive as typed.
    [{ vehicle_properties: { "fuel.type": "Gas" } }, "G"],
  ];
  for (const [over, code] of cases) {
    const base = deal();
    const req = request({
      ...base,
      ...over,
      vehicle_properties: { ...base.vehicle_properties, ...over.vehicle_properties },
    });
    assert.equal(req.fuelType, code, JSON.stringify(over));
    assert.equal(arrayFuel(req), code, JSON.stringify(over));
  }
});

test("a staff edit reaches the rate request through applyStaffEdits", () => {
  // The path fni-rate-vehicle takes: the row with the staff layer applied.
  const edits = {
    "fuel.type": {
      value: "Diesel", original: "Gasoline", original_source: "Default",
      edited_by: "Jim", edited_at: "2026-09-29T12:00:00Z",
    },
  };
  const req = request(applyStaffEdits(deal({ vin_decode: { fuelType: "E" } }), edits));
  assert.equal(req.fuelType, "D");
  assert.equal(arrayFuel(req), "D");
});

test("the sheet and the rate request never disagree", () => {
  for (const over of [
    {}, { vin_decode: { fuelType: "E" } },
    { vehicle_properties: { "fuel.type": "D" } },
    { vehicle_properties: { "fuel.type": "Diesel" }, vin_decode: { fuelType: "E" } },
  ]) {
    const session = deal(over);
    assert.equal(fuelCodeFor(fuelField(session).value), request(session).fuelType);
  }
});

// ── The dropdown's allow-list ────────────────────────────────────────────

test("a fuel edit accepts the three words and nothing else, on both sides", () => {
  const target = editTargetFor("fuel.type");
  for (const word of ["Gasoline", "Electric", "Diesel"]) {
    assert.equal(castForProperty(target, word), word);
    assert.equal(fuelChoice(word), word);
  }
  for (const junk of ["G", "Gas", "E", "Hydrogen", "Gasoline; drop"]) {
    assert.equal(castForProperty(target, junk), null, junk);
  }
  // Engine size and warranty are still taken as typed.
  assert.equal(castForProperty(editTargetFor("engine.ccs"), "650"), "650");

  // The web side forwards only the three words, or a blank.
  const posted = (v) => ratingInputsFrom([["fuel.type", v]]);
  assert.deepEqual(posted("Diesel"), { "fuel.type": "Diesel" });
  assert.deepEqual(posted(""), { "fuel.type": "" });
  assert.deepEqual(posted("Hydrogen"), {});
  assert.deepEqual(posted("G"), {});

  // And the two lists are the same list.
  assert.deepEqual([...FUEL_TYPE_CHOICES], [...FUEL_TYPES]);
});

test("the save path refuses an unreadable fuel type and stores the word", () => {
  const verify = src("../supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /castForProperty\(target, value\)/);
  assert.match(verify, /value: stored,/);
  // Choosing what the deal already resolves to is not an edit, so Save never
  // turns the default into one.
  assert.match(verify, /key === "fuel\.type" && stored === baseField\?\.value/);
});

test("the Verify page offers fuel type as a three-way dropdown", () => {
  const page = src("../apps/ownership-planner/app/verify/[sessionId]/page.tsx");
  assert.match(page, /field\.key === "fuel\.type" \? \(/);
  assert.match(page, /<select id=\{id\} name=\{field\.key\} defaultValue=\{field\.value \?\? "Gasoline"\}>/);
  assert.match(page, /FUEL_TYPE_CHOICES\.map/);
});

// ── The automatic decode ─────────────────────────────────────────────────

const sheetState = (over = {}) => ({
  fields: [{ key: "vin", value: "3JBUKAJ44TK002241" }],
  vin_decode_at: null,
  vin_decode_attempted_at: null,
  ...over,
});

test("the page auto-decodes only a VIN that was never decoded and never tried", () => {
  assert.equal(shouldAutoDecode(sheetState()), true);
  assert.equal(shouldAutoDecode(sheetState({ vin_decode_at: "2026-09-29T12:00:00Z" })), false);
  assert.equal(shouldAutoDecode(sheetState({ vin_decode_attempted_at: "2026-09-29T12:00:00Z" })), false);
  assert.equal(shouldAutoDecode(sheetState({ fields: [{ key: "vin", value: null }] })), false);
  assert.equal(shouldAutoDecode(sheetState({ fields: [{ key: "vin", value: "  " }] })), false);
});

test("a tried and unanswered decode is reported, a successful one is not", () => {
  assert.equal(decodeDidNotAnswer(sheetState()), false);
  assert.equal(decodeDidNotAnswer(sheetState({ vin_decode_attempted_at: "2026-09-29T12:00:00Z" })), true);
  assert.equal(decodeDidNotAnswer(sheetState({
    vin_decode_attempted_at: "2026-09-29T12:00:00Z",
    vin_decode_at: "2026-09-29T12:00:01Z",
  })), false);
  const page = src("../apps/ownership-planner/app/verify/[sessionId]/page.tsx");
  assert.match(page, /The automatic VIN decode did not answer\. Press Decode the VIN to try again\./);
});

test("the page never blocks on the decode", () => {
  const page = src("../apps/ownership-planner/app/verify/[sessionId]/page.tsx");
  const block = page.slice(page.indexOf("if (shouldAutoDecode(sheet))"));
  assert.ok(block.length > 0 && page.includes("if (shouldAutoDecode(sheet))"));

  // Bounded, and every call inside is caught, so a failure or a timeout falls
  // through to rendering the sheet.
  assert.equal(AUTO_DECODE_TIMEOUT_MS, 5000);
  assert.match(block, /try \{\s*await edge\.vinDecode<unknown>\(sessionId, \{ auto: true, timeoutMs: AUTO_DECODE_TIMEOUT_MS \}\);\s*\} catch \(err\) \{\s*console\.error/);
  assert.match(block, /try \{\s*sheet = await edge\.verifySheet<VerifySheet>\(sessionId\);\s*\} catch \(err\) \{\s*\/\/[^\n]*\n\s*console\.error/);

  // The timeout is a real abort on the fetch, not only a number.
  assert.match(src("../apps/ownership-planner/lib/edge.ts"), /AbortSignal\.timeout\(init\.timeoutMs\)/);
});

test("the attempt is recorded before TecAssured is called, and only once when automatic", () => {
  const fn = src("../supabase/functions/fni-vin-decode/index.ts");
  const claim = fn.indexOf('.is("vin_decode_attempted_at", null)');
  const call = fn.indexOf("decodePowersports(vin)");
  assert.ok(claim > 0 && call > claim, "claimed before the provider is called");
  assert.match(fn, /if \(s\.vin_decode_at !== null \|\| s\.vin_decode_attempted_at !== null\) \{\s*return json\(200, \{ session_id: s\.id, skipped: true \}\);/);
  // Every failure after the claim records its reason.
  assert.match(fn, /vin_decode_error: message\.slice\(0, MAX_ERROR\)/);
  assert.doesNotMatch(fn.slice(claim), /return json\((400|502), \{ error/);
});

test("the CRM button does not wait on TecAssured", () => {
  const start = src("../supabase/functions/fni-session-start/index.ts");
  assert.doesNotMatch(start, /_shared\/tecassured\.ts|decodePowersports|fni-vin-decode|vinDecode/);
});
