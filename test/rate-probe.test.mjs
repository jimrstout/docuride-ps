// Rating probes (fni-rate-probe, migration 0050): the request a real rating
// sends with only new.used and finance.type changed, run on the QA server,
// started only by the database, and kept apart from the deal's own rating.
// Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyProbeOverrides,
  NEVER_PROBE_DEAL,
  parseProbeOverrides,
  PROBE_FIELDS,
} from "../supabase/functions/_shared/rate-probe.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const fn = read("supabase/functions/fni-rate-probe/index.ts");

// The shape buildRateRequest returns, with made-up values.
const REQUEST = {
  dealerCode: "0-000", vtype: "ATV", productType: "All", vin: "SAMPLEVIN0000001",
  purchaseType: "New", vehicleStatus: "New", financeType: "Loan", fuelType: "G",
  properties: [
    { name: "fuel.type", value: "G" },
    { name: "new.used", value: "New" },
    { name: "finance.type", value: "Loan" },
    { name: "odometer", value: "3" },
  ],
};

test("probe A: N and F reach the properties array and every top-level field that carries them", () => {
  const out = applyProbeOverrides(REQUEST, { "new.used": "N", "finance.type": "F" });
  assert.deepEqual([out.purchaseType, out.vehicleStatus, out.financeType], ["N", "N", "F"]);
  const prop = (n) => out.properties.find((p) => p.name === n).value;
  assert.deepEqual([prop("new.used"), prop("finance.type")], ["N", "F"]);
  // Nothing else changes.
  assert.deepEqual([prop("fuel.type"), prop("odometer"), out.fuelType, out.vin, out.dealerCode], ["G", "3", "G", "SAMPLEVIN0000001", "0-000"]);
  assert.equal(out.properties.length, 4);
  // The request passed in is untouched.
  assert.equal(REQUEST.purchaseType, "New");
  assert.equal(REQUEST.properties[1].value, "New");
});

test("probe B: only new.used changes; finance.type stays the label", () => {
  const out = applyProbeOverrides(REQUEST, { "new.used": "N", "finance.type": "Loan" });
  assert.deepEqual([out.purchaseType, out.vehicleStatus, out.financeType], ["N", "N", "Loan"]);
  assert.equal(out.properties.find((p) => p.name === "finance.type").value, "Loan");
});

test("a property the provider did not ask for is added, so both halves agree", () => {
  const bare = { ...REQUEST, properties: [{ name: "odometer", value: "3" }] };
  const out = applyProbeOverrides(bare, { "finance.type": "F" });
  assert.deepEqual(out.properties, [{ name: "odometer", value: "3" }, { name: "finance.type", value: "F" }]);
  assert.equal(out.financeType, "F");
});

test("only new.used and finance.type may be changed", () => {
  assert.deepEqual(Object.keys(PROBE_FIELDS), ["new.used", "finance.type"]);
  assert.deepEqual(parseProbeOverrides({ "new.used": "N", "finance.type": "F" }), { overrides: { "new.used": "N", "finance.type": "F" } });
  assert.deepEqual(parseProbeOverrides({ vin: "X" }), { error: "A probe may change only new.used and finance.type, not vin." });
  assert.deepEqual(parseProbeOverrides({}), { error: "The probe names no values to change." });
  assert.deepEqual(parseProbeOverrides({ "new.used": "" }), { error: "The probe's value for new.used is not one that could be sent." });
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
  assert.match(fn, /const request = applyProbeOverrides\(built\.request, parsed\.overrides\);/);
});

test("it writes nothing but its own row: never sessions, rated offers or selections", () => {
  const code = fn.replace(/\/\/.*$/gm, "");
  // Every write goes to fni.rate_probes.
  const writes = [...code.matchAll(/from\("([a-z_]+)"\)\s*\.(update|insert|upsert|delete)\(/g)].map((m) => m[1]);
  assert.ok(writes.length >= 2);
  for (const t of writes) assert.equal(t, "rate_probes");
  assert.doesNotMatch(code, /from\("(rated_offers|selected_products)"\)/);
  assert.match(code, /from\("sessions"\)\.select\("\*"\)/);
  // No fresh CRM sale date read (it can write the session), no cache write, no rating machinery.
  assert.doesNotMatch(code, /freshSaleDate|writeRateProperties|rateSession|recordOutcome|submitContract|voidContract/);
});
