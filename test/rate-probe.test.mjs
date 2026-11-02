// Rating probes (fni-rate-probe, migration 0050): the request a real rating
// sends with chosen form properties or top-level fields changed, run on the QA
// server, started only by the database, and kept apart from the deal's own
// rating. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyProbeOverrides,
  NEVER_PROBE_DEAL,
  parseProbeOverrides,
  PROPERTY_TOP,
} from "../supabase/functions/_shared/rate-probe.ts";
import { codeRequest } from "../supabase/functions/_shared/coded-values.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const fn = read("supabase/functions/fni-rate-probe/index.ts");

// The shape buildRateRequest returns, with made-up values.
const REQUEST = {
  dealerCode: "0-000", vtype: "ATV", productType: "All", vin: "SAMPLEVIN0000001", make: "Sample Make",
  purchaseType: "N", vehicleStatus: "N", financeType: "F", fuelType: "G", displacement: "999", remainingMWM: "12",
  saleDate: "2026-11-02", vehiclePurchaseDate: "2026-11-02", inServiceDate: "2026-11-02", odometer: "1",
  properties: [
    { name: "fuel.type", value: "G" }, { name: "make", value: "Sample Make" }, { name: "new.used", value: "N" },
    { name: "engine.ccs", value: "999" }, { name: "finance.type", value: "F" }, { name: "warranty", value: "12" },
    { name: "odometer", value: "1" },
  ],
};
const parsed = (raw) => parseProbeOverrides(raw).overrides;
const prop = (req, n) => req.properties.find((p) => p.name === n)?.value;

test("a property changes the form entry and its paired top-level field", () => {
  const out = applyProbeOverrides(REQUEST, parsed({ properties: { make: "BRP", "engine.ccs": 799, warranty: "24" } }));
  assert.deepEqual([prop(out, "make"), out.make], ["BRP", "BRP"]);
  assert.deepEqual([prop(out, "engine.ccs"), out.displacement], ["799", "799"]);
  assert.deepEqual([prop(out, "warranty"), out.remainingMWM], ["24", "24"]);
  // Nothing else changes, and the request passed in is untouched.
  assert.deepEqual([out.vin, out.financeType, prop(out, "fuel.type")], ["SAMPLEVIN0000001", "F", "G"]);
  assert.equal(REQUEST.make, "Sample Make");
  assert.equal(PROPERTY_TOP["sale.date"].join(","), "saleDate,vehiclePurchaseDate");
});

test("a property the request does not carry is added; a top-level field is set or removed", () => {
  const out = applyProbeOverrides(REQUEST, parsed({ properties: { "service.drive": "Y" }, top: { serviceDrive: true, saleType: "Service", odometer: null } }));
  assert.equal(prop(out, "service.drive"), "Y");
  assert.equal(out.serviceDrive, true);
  assert.equal(out.saleType, "Service");
  assert.equal("odometer" in out, false);
  // A top-level value wins over the one its property would set.
  const both = applyProbeOverrides(REQUEST, parsed({ properties: { "inservice.date": "2026-03-02" }, top: { vehiclePurchaseDate: "2026-03-02" } }));
  assert.deepEqual([both.inServiceDate, both.vehiclePurchaseDate, both.saleDate], ["2026-03-02", "2026-03-02", "2026-11-02"]);
});

test("coded properties still go out as codes; top-level values exactly as given", () => {
  // As the function does it: properties, then coding, then the top-level values.
  const withProps = applyProbeOverrides(REQUEST, parsed({ properties: { "new.used": "New", "finance.type": "Loan" } }));
  const coded = codeRequest(withProps, null).request;
  assert.deepEqual([prop(coded, "new.used"), coded.purchaseType, prop(coded, "finance.type"), coded.financeType], ["N", "N", "F", "F"]);
  const raw = applyProbeOverrides(coded, parsed({ top: { purchaseType: "Service" } }));
  assert.deepEqual([raw.purchaseType, raw.vehicleStatus], ["Service", "N"]);
  assert.match(fn, /const coded = codeRequest\(applyProbeOverrides\(built\.request, \{ properties: parsed\.overrides\.properties, top: \{\} \}\), formCodes\);/);
  assert.match(fn, /const request = applyProbeOverrides\(coded\.request, \{ properties: \{\}, top: parsed\.overrides\.top \}\);/);
});

test("the first probes' flat overrides are still read; anything unsendable is refused", () => {
  assert.deepEqual(parsed({ "new.used": "N", "finance.type": "F" }), { properties: { "new.used": "N", "finance.type": "F" }, top: {} });
  assert.deepEqual(parseProbeOverrides({}), { error: "The probe names no values to change." });
  assert.deepEqual(parseProbeOverrides({ properties: { "bad name!": "x" } }), { error: '"bad name!" is not a property name that could be sent.' });
  assert.deepEqual(parseProbeOverrides({ top: { serviceDrive: { nested: true } } }), { error: "The probe's value for serviceDrive is not one that could be sent." });
});

test("started only by the database: a one-time token, spent as the probe starts", () => {
  assert.match(fn, /\.update\(\{ status: "Running", token: null, started_at: new Date\(\)\.toISOString\(\) \}\)\s*\.eq\("id", probeId\)\.eq\("token", token\)\.eq\("status", "Requested"\)\.gt\("requested_at", since\)/);
  assert.match(fn, /if \(!probe\) return json\(401, \{ error: "Not a probe waiting to run\." \}\);/);
  assert.match(read("supabase/config.toml"), /\[functions\.fni-rate-probe\]\nverify_jwt = false/);
});

test("QA only, never deal 14957, and the request is the real rating's", () => {
  assert.match(fn, /if \(environment !== "Test"\) return await fail\(/);
  assert.equal(NEVER_PROBE_DEAL, "14957");
  assert.match(fn, /if \(String\(s\.deal_number \?\? ""\) === NEVER_PROBE_DEAL\)/);
  assert.match(fn, /const rateSource = applyStaffEdits\(s, parseStaffEdits\(s\.staff_edits\)\);/);
  assert.match(fn, /const built = buildRateRequest\(required, rateSource as unknown as RateSource, \{ dealerCode: store\.dealerCode, vtype \}\);/);
});

test("it writes nothing but its own row: never sessions, rated offers or selections", () => {
  const code = fn.replace(/\/\/.*$/gm, "");
  const writes = [...code.matchAll(/from\("([a-z_]+)"\)\s*\.(update|insert|upsert|delete)\(/g)].map((m) => m[1]);
  assert.ok(writes.length >= 2);
  for (const t of writes) assert.equal(t, "rate_probes");
  assert.doesNotMatch(code, /from\("(rated_offers|selected_products)"\)/);
  assert.match(code, /from\("sessions"\)\.select\("\*"\)/);
  assert.doesNotMatch(code, /freshSaleDate|writeRateProperties|rateSession|recordOutcome|submitContract|voidContract/);
});

test("a makes probe asks the provider for its makes list, QA only, kept on its own row", async () => {
  const { isMakesProbe } = await import("../supabase/functions/_shared/rate-probe.ts");
  assert.equal(isMakesProbe({ action: "makes" }), true);
  assert.equal(isMakesProbe({ properties: { make: "BRP" } }), false);
  // After the QA check, and before anything about rating.
  assert.ok(fn.indexOf('if (environment !== "Test")') < fn.indexOf("if (makesOnly) {"));
  assert.match(fn, /response = await store\.client\.getMakes\(store\.dealerCode\);/);
  assert.match(read("supabase/functions/_shared/tecassured.ts"), /return await this\.apiCall\("POST", "\/ps\/makes", \{ dealerCode: this\.dealer\(dealerCode\) \}\);/);
});
