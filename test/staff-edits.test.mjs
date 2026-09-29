// Staff edits to rating inputs: what the screen shows, what reaches the
// provider, and when the CRM warning appears and goes away.
//
// The load-bearing property is that ONE function decides what a rating input is
// worth, and both the screen and the rate request go through it. So these tests
// check the sheet and the applied source side by side: a case where those two
// disagree is a case where the customer is shown one price and quoted another.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerification,
  editTargetFor,
  editableKeys,
  labelFor,
  ratingInputs,
} from "../supabase/functions/_shared/verification.ts";
import {
  applyStaffEdits,
  castForColumn,
  crmMismatchWarning,
  financeTypeColumnValue,
  parseStaffEdits,
} from "../supabase/functions/_shared/staff-edits.ts";

const UTV = [
  "vin", "fuel.type", "year", "make", "model", "new.used", "engine.ccs",
  "finance.type", "finance.amount", "finance.apr", "finance.term", "odometer",
  "price", "sale.date", "inservice.date", "Warranty", "postal.code",
];

/** Deal 14132 as fni.sessions holds it. A real cash deal. */
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
  staff_edits: null,
  ...over,
});

const edit = (over = {}) => ({
  value: "18500",
  original: "$16,899.00",
  original_source: "CRM",
  edited_by: "jim@example.com",
  edited_at: "2026-09-27T14:02:11.000Z",
  ...over,
});

const sheet = (edits = {}, over = {}) =>
  buildVerification(defender(over), UTV, edits);

const byKey = (s) => Object.fromEntries(s.fields.map((f) => [f.key, f]));

const applied = (edits = {}, over = {}) =>
  applyStaffEdits(defender(over), edits, editTargetFor);

// ─────────────────────────────────────────────────────────────────────────
// The screen: was, now, and who
// ─────────────────────────────────────────────────────────────────────────

test("an edited field shows the new value, the original, and its source", () => {
  const f = byKey(sheet({ sale_price: edit() })).sale_price;
  assert.equal(f.value, "$18,500.00");
  assert.equal(f.source, "Edited by Staff");
  assert.equal(f.original, "$16,899.00");
  assert.equal(f.original_source, "CRM");
  assert.equal(f.edited_by, "jim@example.com");
  assert.equal(f.edited_at, "2026-09-27T14:02:11.000Z");
});

test("was and now go through the same formatter", () => {
  // The person typed 18500. If the sheet showed that raw beside "$16,899.00" the
  // comparison would read as a currency change, and "does this still differ from
  // CRM" could never be answered by comparing the two strings.
  const f = byKey(sheet({ sale_price: edit({ value: "18500" }) })).sale_price;
  assert.equal(f.value, "$18,500.00");
  assert.match(f.original, /^\$/);
});

test("an untouched field carries no edit story at all", () => {
  const f = byKey(sheet()).sale_price;
  assert.equal(f.original, null);
  assert.equal(f.original_source, null);
  assert.equal(f.edited_by, null);
  assert.equal(f.differs_from_crm, false);
});

test("filling a field nothing carried reads as Entered, not Edited", () => {
  // Engine size on a session with no decode: there was nothing to edit over, so
  // "Edited by Staff" would imply a value it replaced.
  const f = byKey(sheet({ "engine.ccs": edit({ value: "650", original: null, original_source: "Missing" }) }))["engine.ccs"];
  assert.equal(f.source, "Entered by Staff");
  assert.equal(f.value, "650");
});

test("correcting a decoded value reads as Edited over VIN Decode", () => {
  const s = sheet(
    { "engine.ccs": edit({ value: "700", original: "650", original_source: "VIN Decode" }) },
    { vin_decode: { displacement: "650", fuelType: "G", vtype: "UTV" } }
  );
  const f = byKey(s)["engine.ccs"];
  assert.equal(f.source, "Edited by Staff");
  assert.equal(f.original, "650");
  assert.equal(f.original_source, "VIN Decode");
});

// ─────────────────────────────────────────────────────────────────────────
// The CRM warning
// ─────────────────────────────────────────────────────────────────────────

test("the warning is Jim's sentence, naming the fields", () => {
  const s = sheet({ sale_price: edit(), odometer: edit({ value: "12", original: "1" }) });
  // Sheet order, not the order they were edited in: Odometer sits under Vehicle
  // and Sale price under Money, so that is how they read.
  assert.equal(
    s.crm_warning,
    "These values now differ from the CRM deal: Odometer, Sale price. " +
      "Update the deal in CRM so the sale documents match."
  );
});

test("one field reads as a list of one, not as a special case", () => {
  assert.equal(
    sheet({ sale_price: edit() }).crm_warning,
    "These values now differ from the CRM deal: Sale price. " +
      "Update the deal in CRM so the sale documents match."
  );
});

test("no edits means no warning", () => {
  const s = sheet();
  assert.equal(s.crm_warning, null);
  assert.deepEqual(s.crm_mismatches, []);
  assert.deepEqual(s.edited, []);
});

test("the warning clears itself once CRM catches up", () => {
  // The whole point of comparing against what CRM says NOW rather than against
  // the stored original: somebody fixes the deal, presses Refresh, and the
  // warning goes away without anybody clearing it by hand.
  const before = sheet({ sale_price: edit({ value: "18500" }) });
  assert.equal(before.crm_warning !== null, true);

  const after = sheet({ sale_price: edit({ value: "18500" }) }, { sale_price: "18500" });
  assert.equal(after.crm_warning, null);
  assert.deepEqual(after.crm_mismatches, []);
  // The edit is still on the record, and still says a person made it.
  assert.equal(byKey(after).sale_price.source, "Edited by Staff");
  assert.equal(byKey(after).sale_price.differs_from_crm, false);
});

test("a field the CRM does not carry never raises a warning", () => {
  // Engine size, factory warranty and fuel type. There is no CRM value for them
  // to differ from, so warning about them would be noise.
  const s = sheet({
    "engine.ccs": edit({ value: "650", original: null, original_source: "Missing" }),
    warranty: edit({ value: "36", original: null, original_source: "Missing" }),
    "fuel.type": edit({ value: "G", original: null, original_source: "Missing" }),
  });
  assert.equal(s.crm_warning, null);
  assert.equal(s.edited.length, 3);
  for (const f of s.edited) assert.equal(f.in_crm, false);
});

test("a mismatch records who moved it and when", () => {
  const [m] = sheet({ odometer: edit({ value: "412", original: "1" }) }).crm_mismatches;
  assert.equal(m.key, "odometer");
  assert.equal(m.label, "Odometer");
  assert.equal(m.crm_value, "1");
  assert.equal(m.edited_value, "412");
  assert.equal(m.edited_by, "jim@example.com");
  assert.equal(m.edited_at, "2026-09-27T14:02:11.000Z");
});

test("a mismatch does not block verifying", () => {
  // Jim's rule: staff can still verify, and the warning stays visible.
  const s = sheet(
    { sale_price: edit() },
    // A complete sheet otherwise: UTV asks for engine size, warranty and fuel
    // type, and none of the three has a CRM source.
    { vin_decode: { displacement: "650", fuelType: "G", vtype: "UTV" },
      vehicle_properties: { warranty: "36" } }
  );
  assert.equal(s.crm_warning !== null, true);
  assert.equal(s.ready, true, `blocked by: ${s.missing.map((f) => f.label).join(", ")}`);
});

// ─────────────────────────────────────────────────────────────────────────
// What reaches the provider
// ─────────────────────────────────────────────────────────────────────────

test("an edited price reaches the session the rate is built from", () => {
  const out = applied({ sale_price: edit({ value: "18500" }) });
  assert.equal(out.sale_price, 18500);
  assert.equal(typeof out.sale_price, "number");
});

test("the row itself is never mutated", () => {
  // The unedited values are what the "was" line is made of, so a caller that
  // applied the layer must still be holding the originals.
  const row = defender();
  applyStaffEdits(row, { sale_price: edit({ value: "18500" }) }, editTargetFor);
  assert.equal(row.sale_price, "16899");
});

test("money, months and dates are cast for the column, not passed as text", () => {
  const out = applied({
    sale_price: edit({ value: "$25,500.00" }),
    odometer: edit({ value: "412 " }),
    sale_date: edit({ value: "2026-10-01" }),
    unit_year: edit({ value: "2025" }),
  });
  assert.equal(out.sale_price, 25500);
  assert.equal(out.odometer, 412);
  assert.equal(out.sale_date, "2026-10-01");
  assert.equal(out.unit_year, 2025);
});

test("deal type round-trips through the word staff read", () => {
  // The screen says Finance. The column holds Loan. Without the mapping the
  // column would get a value its CHECK does not allow.
  assert.equal(financeTypeColumnValue("Finance"), "Loan");
  assert.equal(financeTypeColumnValue("Cash"), "Cash");
  assert.equal(financeTypeColumnValue("Lease"), "Lease");
  assert.equal(financeTypeColumnValue("nonsense"), null);

  const out = applied({ deal_type: edit({ value: "Finance", original: "Cash" }) });
  assert.equal(out.finance_type, "Loan");
  assert.equal(byKey(sheet({ deal_type: edit({ value: "Finance", original: "Cash" }) })).deal_type.value, "Finance");
});

test("the fields CRM does not carry land where the rate builder looks for them", () => {
  // vehicle_properties, keyed by the provider's own property name, which is
  // where buildRateRequest already reads overrides from.
  const out = applied({
    "engine.ccs": edit({ value: "650", original: null, original_source: "Missing" }),
    warranty: edit({ value: "36", original: null, original_source: "Missing" }),
  });
  assert.deepEqual(out.vehicle_properties, { "engine.ccs": "650", warranty: "36" });
});

test("an existing vehicle_properties value survives the layer", () => {
  const out = applied(
    { warranty: edit({ value: "36", original: null, original_source: "Missing" }) },
    { vehicle_properties: { "engine.ccs": "650" } }
  );
  assert.deepEqual(out.vehicle_properties, { "engine.ccs": "650", warranty: "36" });
});

test("an edited vehicle type is what decides which fields are asked for", () => {
  // The Defender case. A body type nobody fixed in Zoho is corrected here, and
  // the required-properties lookup has to follow the correction.
  const out = applied(
    { vehicle_type_code: edit({ value: "utv", original: null, original_source: "Missing" }) },
    { vehicle_type_code: null }
  );
  assert.equal(out.vehicle_type_code, "UTV", "must be upper-cased for the lookup");
});

// ─────────────────────────────────────────────────────────────────────────
// A value that cannot be read
// ─────────────────────────────────────────────────────────────────────────

test("an unreadable number is not applied, so the CRM figure stands", () => {
  assert.equal(castForColumn({ kind: "column", column: "sale_price", cast: "number" }, "abc"), null);
  const out = applied({ sale_price: edit({ value: "abc" }) });
  assert.equal(out.sale_price, "16899");
});

test("an unreadable edit is reported and blocks verifying", () => {
  // The alternative is a screen implying the correction took effect while the
  // provider is quoted the figure the person just rejected.
  const s = sheet(
    { sale_price: edit({ value: "abc" }) },
    { vin_decode: { displacement: "650", fuelType: "G", vtype: "UTV" },
      vehicle_properties: { warranty: "36" } }
  );
  assert.equal(s.invalid.length, 1);
  assert.equal(s.invalid[0].key, "sale_price");
  assert.equal(s.ready, false);
  // And it is not quietly counted as agreeing with CRM.
  assert.equal(byKey(s).sale_price.differs_from_crm, false);
  assert.equal(byKey(s).sale_price.invalid, true);
});

// ─────────────────────────────────────────────────────────────────────────
// Which fields are editable
// ─────────────────────────────────────────────────────────────────────────

test("the two identifiers have no edit target at all", () => {
  assert.equal(editTargetFor("deal_number"), null);
  assert.equal(editTargetFor("stock_number"), null);
  assert.notEqual(editTargetFor("sale_price"), null);
});

test("editableKeys closes the finance figures on a cash deal and opens them on a loan", () => {
  const cash = editableKeys(defender());
  for (const k of ["amount_financed", "finance_term", "apr"]) {
    assert.equal(cash.includes(k), false, `${k} must be shut on a cash deal`);
  }
  const loan = editableKeys(defender({ finance_type: "Loan" }));
  for (const k of ["amount_financed", "finance_term", "apr"]) {
    assert.equal(loan.includes(k), true, `${k} must open on a financed deal`);
  }
});

test("neither identifier is ever editable", () => {
  for (const src of [defender(), defender({ finance_type: "Loan" })]) {
    const keys = editableKeys(src);
    assert.equal(keys.includes("deal_number"), false);
    assert.equal(keys.includes("stock_number"), false);
  }
});

test("labelFor names a field the way the screen does", () => {
  assert.equal(labelFor("sale_price"), "Sale price");
  assert.equal(labelFor("engine.ccs"), "Engine size (cc)");
  assert.equal(labelFor("nonsense"), "nonsense");
});

// ─────────────────────────────────────────────────────────────────────────
// The comparison the verification gate runs on
// ─────────────────────────────────────────────────────────────────────────

test("ratingInputs covers the three fields requiredproperties never names", () => {
  // The vehicle type decides what is asked for at all; city and state go up as
  // customerCity and customerState. A change to any of them changes the request.
  const inputs = ratingInputs(sheet());
  for (const k of ["vehicle_type_code", "buyer_city", "buyer_state"]) {
    assert.ok(k in inputs, `${k} must count as a rating input`);
  }
});

test("ratingInputs leaves out the only two fields that cannot move a price", () => {
  const inputs = ratingInputs(sheet());
  assert.equal("deal_number" in inputs, false);
  assert.equal("stock_number" in inputs, false);
});

test("ratingInputs reports the edited value, because that is what is sent", () => {
  assert.equal(ratingInputs(sheet({ sale_price: edit({ value: "18500" }) })).sale_price, "$18,500.00");
});

// ─────────────────────────────────────────────────────────────────────────
// Reading the stored layer
// ─────────────────────────────────────────────────────────────────────────

test("a malformed staff_edits column parses to nothing rather than throwing", () => {
  for (const raw of [null, undefined, "text", 42, [], [{ value: "x" }]]) {
    assert.deepEqual(parseStaffEdits(raw), {});
  }
});

test("an entry with no usable value is dropped", () => {
  assert.deepEqual(parseStaffEdits({ sale_price: { value: "  " } }), {});
  assert.deepEqual(parseStaffEdits({ sale_price: { original: "x" } }), {});
});

test("a stored entry missing its provenance still parses, named unknown", () => {
  const out = parseStaffEdits({ sale_price: { value: "18500" } });
  assert.equal(out.sale_price.value, "18500");
  assert.equal(out.sale_price.original, null);
  assert.equal(out.sale_price.original_source, "Missing");
  assert.equal(out.sale_price.edited_by, "unknown");
});

// ─────────────────────────────────────────────────────────────────────────
// House rules
// ─────────────────────────────────────────────────────────────────────────

test("nothing in the warning sentence is an em dash", () => {
  const s = crmMismatchWarning([
    { key: "sale_price", label: "Sale price", crm_value: "a", edited_value: "b", edited_by: "x", edited_at: "y" },
  ]);
  assert.ok(!s.includes("—"));
});

test("crmMismatchWarning says nothing when there is nothing to say", () => {
  assert.equal(crmMismatchWarning([]), null);
});

// ─────────────────────────────────────────────────────────────────────────
// The endpoints, checked structurally
//
// They cannot be imported from node -- they pull `serve` from deno.land -- so
// these read the source for the specific constructs the rules depend on. Each
// one is a thing that could go missing and leave the screen showing a figure the
// provider was never told about, with nothing else failing.
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

const verifyFn = src("../supabase/functions/fni-session-verify/index.ts");
const saveEditsFn = readFileSync(
  new URL("../supabase/functions/fni-session-verify/save-edits.ts", import.meta.url),
  "utf8"
);
const rateFn = src("../supabase/functions/fni-rate-vehicle/index.ts");
const plannerFn = src("../supabase/functions/fni-session-get/index.ts");
const migration = src("../supabase/migrations/0016_staff_edits.sql");

test("the edits live in their own column, not over the CRM's", () => {
  assert.match(migration, /add column if not exists staff_edits jsonb/);
  assert.match(migration, /jsonb_typeof\(staff_edits\) = 'object'/);
});

test("an edit is refused without a name on it", () => {
  assert.match(verifyFn, /edited_by is required: an edit names a person\./);
  // The edit itself is built in save-edits.ts, with the same name on it.
  assert.match(verifyFn, /editFor\(target, stored, baseByKey\.get\(key\), edits\[key\], editedBy, now\)/);
  assert.match(saveEditsFn, /edited_by: editedBy/);
});

test("the fixed three-key allowlist is gone", () => {
  // Which fields may be edited is a property of the sheet now, and it depends on
  // the deal. A second list here would drift from the one the screen greys.
  assert.doesNotMatch(verifyFn, /const EDITABLE_KEYS/);
  assert.match(verifyFn, /editableKeys\(provisional\)/);
});

test("a second edit keeps the first original", () => {
  // Editing a price twice must still record what the CRM said, not what the last
  // person typed, or the audit trail loses the only figure that mattered.
  // Built in save-edits.ts now, where save() gets each edit from.
  assert.match(saveEditsFn, /original: existing \? existing\.original :/);
});

test("an unreadable value is refused before it is stored", () => {
  const save = verifyFn.slice(verifyFn.indexOf("async function save("));
  const guard = save.indexOf("castForColumn(target, value) === null");
  const stored = save.indexOf("edits[key] = edit;");
  assert.ok(guard > 0 && guard < stored);
});

test("refresh never touches the edits column", () => {
  const refresh = verifyFn.slice(
    verifyFn.indexOf("async function refresh("),
    verifyFn.indexOf("async function verify(")
  );
  assert.doesNotMatch(refresh, /staff_edits:/, "a refresh must keep staff edits");
  assert.match(refresh, /crmRatingFields\(record/);
});

test("refresh compares with the edits applied", () => {
  // Otherwise a CRM field moving underneath an edit would un-verify a session
  // whose rate request did not change at all.
  const refresh = verifyFn.slice(
    verifyFn.indexOf("async function refresh("),
    verifyFn.indexOf("async function verify(")
  );
  assert.match(refresh, /buildVerification\([\s\S]{0,120}freshEdits\)/);
});

test("discard drops the CRM overrides and keeps what CRM cannot supply", () => {
  const discard = verifyFn.slice(verifyFn.indexOf("async function discardEdits("));
  assert.match(discard, /f\.in_crm/);
  assert.match(discard, /else kept\[key\] = edit;/);
  // And it reloads, which is the other half of what the button says.
  assert.match(discard, /return await refresh\(/);
});

test("the verification snapshot records who changed what, from what, to what", () => {
  const verify = verifyFn.slice(verifyFn.indexOf("async function verify("));
  for (const field of ["from:", "from_source:", "to:", "edited_by:", "edited_at:"]) {
    assert.ok(verify.includes(field), `snapshot must record ${field}`);
  }
  assert.match(verify, /staff_edits: sheet\.edited\.map/);
  assert.match(verify, /crm_mismatches: sheet\.crm_mismatches/);
});

test("a CRM mismatch is not in the list of things that refuse a verification", () => {
  const verify = verifyFn.slice(verifyFn.indexOf("async function verify("));
  const refusal = verify.slice(0, verify.indexOf("const now = new Date()"));
  assert.doesNotMatch(refusal, /crm_mismatch|differs_from_crm/);
});

test("the required-properties lookup follows an edited vehicle type", () => {
  // The Defender case. Looking it up from the CRM value would leave the screen
  // checking the wrong list of fields against the right vehicle.
  const occurrences = verifyFn.match(/applyStaffEdits\([\s\S]{0,160}?vehicle_type_code/g) ?? [];
  assert.ok(occurrences.length >= 2, "sheetFor and verify must both use the edited vtype");
});

test("the rate request is built from the edited session", () => {
  assert.match(rateFn, /buildRateRequest\(required, rateSource as unknown as RateSource/);
  assert.match(rateFn, /const rateSource = applyStaffEdits\(/);
  assert.doesNotMatch(rateFn, /buildRateRequest\(required, sess\b/);
});

test("the overrides parameter no longer writes over the CRM's columns", () => {
  // It used to persist them, which is now exactly what the design forbids: it
  // destroys the figure "differs from the CRM deal" has to be measured against.
  const step2 = rateFn.slice(
    rateFn.indexOf("Step 2b: The overrides parameter"),
    rateFn.indexOf("Step 3")
  );
  assert.doesNotMatch(step2, /\.update\(/);
  assert.match(step2, /rateSource\[key\] = overrides\[key\]/);
});

test("the planner is untouched, and that is a decision for Jim", () => {
  // The staff layer deliberately does NOT reach fni-session-get. A corrected
  // sale price moves the rate; the customer's screen still shows the CRM figure
  // until the deal is corrected in CRM, which is what the mismatch warning is
  // for. Changing the customer-facing money path was not asked for, and doing it
  // silently is worse than leaving the transitional mismatch visible to staff.
  assert.doesNotMatch(plannerFn, /applyStaffEdits/);
});

test("the rate builder does not import the staff screen", () => {
  // Where an edit lands is not a display question, so it lives in staff-edits.ts.
  assert.doesNotMatch(
    rateFn,
    /_shared\/verification\.ts/,
    "the rate builder must not import the Verify sheet"
  );
});

test("there is exactly one table saying where an edit lands", () => {
  const verification = src("../supabase/functions/_shared/verification.ts");
  // Two copies of this mapping is how the screen and the provider end up
  // disagreeing about which column a corrected price belongs in.
  assert.doesNotMatch(verification, /kind: "column"/);
  assert.doesNotMatch(verification, /kind: "property"/);
  const edits = src("../supabase/functions/_shared/staff-edits.ts");
  assert.match(edits, /export const EDIT_TARGETS/);
});

test("no provenance reaches the customer's browser", () => {
  // Whatever else changes about the planner, who edited what is staff business.
  for (const leak of ["edited_by", "original_source", "crm_warning", "crm_mismatches"]) {
    assert.ok(!plannerFn.includes(leak), `${leak} must not reach the planner payload`);
  }
});

// ── Save: only a real change is an edit ──────────────────────────────────
//
// The Verify form posts every input, pre-filled with what the sheet showed. A
// value that means the same as the unedited one must not become an edit, or a
// single press of Save marks every field "Edited by Staff, was <same value>".
// Session 9906521b did exactly that.

import { editFor, sameAsUnedited } from "../supabase/functions/fni-session-verify/save-edits.ts";
import { castForProperty } from "../supabase/functions/_shared/staff-edits.ts";

/**
 * What save() does with a posted form, minus the endpoint around it: skip a
 * blank, cast a property to the stored form, then keep or drop the edit.
 */
function simulateSave(session, posted, edits = {}) {
  const base = new Map(buildVerification(session, []).fields.map((f) => [f.key, f]));
  const out = { ...edits };
  const now = "2026-09-29T18:00:00.000Z";
  for (const [key, raw] of Object.entries(posted)) {
    const value = String(raw).trim();
    if (value === "") { delete out[key]; continue; }
    const target = editTargetFor(key);
    let stored = value;
    if (target && target.kind === "property") stored = castForProperty(target, value);
    const next = editFor(target, stored, base.get(key), out[key], "Jim", now);
    if (next === null) delete out[key];
    else out[key] = next;
  }
  return out;
}

/** Every editable field posted exactly as the sheet displays it. */
function postedAsShown(session) {
  const s = buildVerification(session, UTV);
  const keys = new Set(editableKeys(session));
  return Object.fromEntries(
    s.fields.filter((f) => keys.has(f.key) && f.value !== null).map((f) => [f.key, f.value])
  );
}

test("posting every field unchanged creates no edits", () => {
  // A financed deal, so the money fields are open too, with values that show
  // formatted: "$24,999.00", "6.99%", "Finance", and a decode for engine and fuel.
  const deal = defender({
    finance_type: "Loan", lienholder_name: "Roadrunner Financial LLC.",
    sale_price: "24999", amount_financed: "26500.5", apr: 6.99,
    finance_term: 60, finance_term_total: 60,
    vin_decode: { displacement: "650", fuelType: "G", vtype: "UTV" },
    vehicle_properties: { warranty: "6" },
  });
  const posted = postedAsShown(deal);
  // The sheet really does show them formatted, so this is the case that broke.
  assert.equal(posted.sale_price, "$24,999.00");
  assert.equal(posted.apr, "6.99%");
  assert.equal(posted.deal_type, "Finance");
  assert.ok(Object.keys(posted).length >= 15, "most of the sheet is posted");

  assert.deepEqual(simulateSave(deal, posted), {});
});

test("a formatting-only difference is not an edit", () => {
  const target = editTargetFor("sale_price");
  for (const same of ["24999", "24,999", "$24,999.00", " 24999.00 "]) {
    assert.equal(sameAsUnedited(target, same, "$24,999.00"), true, same);
  }
  assert.equal(sameAsUnedited(editTargetFor("apr"), "6.99", "6.99%"), true);
  assert.equal(sameAsUnedited(editTargetFor("deal_type"), "Loan", "Finance"), true);
  assert.equal(sameAsUnedited(editTargetFor("sale_date"), "09/26/2026", "2026-09-26"), true);
  assert.equal(sameAsUnedited(editTargetFor("vehicle_type_code"), "utv", "UTV"), true);

  const deal = defender({ sale_price: "24999" });
  assert.deepEqual(simulateSave(deal, { sale_price: "24999" }), {});
});

test("a real change creates exactly one edit", () => {
  const deal = defender({ sale_price: "24999" });
  const posted = { ...postedAsShown(deal), sale_price: "23500" };
  const edits = simulateSave(deal, posted);
  assert.deepEqual(Object.keys(edits), ["sale_price"]);
  assert.equal(edits.sale_price.value, "23500");
  assert.equal(edits.sale_price.original, "$24,999.00");
  assert.equal(edits.sale_price.original_source, "CRM");

  // Typing into an empty field is always an edit.
  assert.equal(sameAsUnedited(editTargetFor("engine.ccs"), "650", null), false);
});

test("setting an edited field back to the original removes the edit", () => {
  const deal = defender({ sale_price: "24999" });
  const first = simulateSave(deal, { sale_price: "23500" });
  assert.ok(first.sale_price);
  const back = simulateSave(deal, { sale_price: "$24,999.00" }, first);
  assert.deepEqual(back, {});

  // And a second real change keeps the first original.
  const twice = simulateSave(deal, { sale_price: "23000" }, first);
  assert.equal(twice.sale_price.value, "23000");
  assert.equal(twice.sale_price.original, "$24,999.00");
});

test("choosing the fuel type the deal already resolves to creates no edit", () => {
  // The Gasoline default, and a decoded diesel.
  assert.deepEqual(simulateSave(defender(), { "fuel.type": "Gasoline" }), {});
  const diesel = defender({ vin_decode: { fuelType: "D" } });
  assert.deepEqual(simulateSave(diesel, { "fuel.type": "Diesel" }), {});
  // A different choice is an edit, stored as the word.
  assert.equal(simulateSave(diesel, { "fuel.type": "Electric" })["fuel.type"].value, "Electric");
});

test("save() uses the general rule and no fuel-only special case", () => {
  const verify = readFileSync(
    new URL("../supabase/functions/fni-session-verify/index.ts", import.meta.url), "utf8");
  const save = verify.slice(verify.indexOf("async function save("), verify.indexOf("async function discardEdits("));
  assert.match(save, /const edit = editFor\(target, stored, baseByKey\.get\(key\), edits\[key\], editedBy, now\);\s*if \(edit === null\) \{\s*delete edits\[key\];\s*continue;\s*\}/);
  assert.doesNotMatch(save, /key === "fuel\.type"/);
});
