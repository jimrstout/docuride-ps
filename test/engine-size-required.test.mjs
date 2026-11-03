// Engine size required, above 0 (2 Nov probes, follow-up 2).
//
// With engine.ccs 0, deal 15063's rating lost every Mechanical Protection plan
// and the provider said nothing. Wherever the provider's form asks for
// engine.ccs, rating needs a whole number above 0: Details says why, Verify
// refuses, and the rating itself refuses before anything is sent. Mock data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ENGINE_SIZE_PROBLEM, engineSizeProblem } from "../supabase/functions/_shared/engine-size.ts";
import { buildVerification } from "../supabase/functions/_shared/verification.ts";
import { detailsSource, verifySource } from "./details-source.mjs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const DEAL = {
  deal_number: "99901", unit_year: 2026, unit_make: "Can-Am", unit_model: "Sample", condition: "New",
  vehicle_type_code: "ATV", odometer: 3, sale_price: 12999, finance_type: "Cash", sale_date: "2026-11-02",
  buyer_zip: "83702", buyer_city: "Boise", buyer_state: "ID", vin: "SAMPLEVIN0000001",
  vehicle_properties: { warranty: "12" },
};
const ATV = ["vin", "year", "make", "model", "new.used", "engine.ccs", "warranty", "price", "odometer", "sale.date", "postal.code", "fuel.type", "finance.type"];
const engine = (sheet) => sheet.fields.find((f) => f.key === "engine.ccs");

test("a whole number above 0 is fine; 0, a fraction or words are not", () => {
  assert.equal(engineSizeProblem("999"), null);
  assert.equal(engineSizeProblem("1"), null);
  for (const v of ["0", "00", "-650", "650.5", "six fifty", "650cc"]) assert.equal(engineSizeProblem(v), ENGINE_SIZE_PROBLEM, v);
  // Empty is "missing", reported as missing, not as this.
  assert.equal(engineSizeProblem(""), null);
  assert.equal(engineSizeProblem(null), null);
});

test("Details says why, and the sheet is not ready, when the form asks for engine size", () => {
  const zero = buildVerification({ ...DEAL, vehicle_properties: { warranty: "12", "engine.ccs": "0" } }, ATV);
  assert.equal(engine(zero).problem, ENGINE_SIZE_PROBLEM);
  assert.equal(zero.ready, false);
  assert.deepEqual(zero.problems.map((f) => f.key), ["engine.ccs"]);
  const ok = buildVerification({ ...DEAL, vehicle_properties: { warranty: "12", "engine.ccs": "999" } }, ATV);
  assert.equal(engine(ok).problem, null);
  assert.equal(ok.ready, true);
  // A vehicle type whose form does not ask for engine size is not held up by it.
  const noEngine = buildVerification({ ...DEAL, vehicle_properties: { warranty: "12", "engine.ccs": "0" } }, ATV.filter((p) => p !== "engine.ccs"));
  assert.equal(engine(noEngine).problem, null);
  assert.equal(ENGINE_SIZE_PROBLEM, "Engine size must be a whole number of cc above 0. With 0, or a size that is not a whole number, the provider offers no Mechanical Protection. Enter the engine size on Details.");
});

test("Verify refuses with the reason, Details shows it, and the rating refuses before sending", () => {
  const verify = verifySource();
  assert.match(verify, /: sheet\.problems\.length > 0\s*\? sheet\.problems\.map\(\(f\) => f\.problem\)\.join\(" "\)/);
  const page = detailsSource();
  assert.match(page, /\{field\.problem \? \(\s*<p className="vfield-note" role="alert">\{field\.problem\}<\/p>/);
  const adapter = read("supabase/functions/_shared/adapters/tecassured.ts");
  assert.ok(adapter.indexOf("const problem = engineSizeProblem(cc);") < adapter.indexOf("store.client.rateVehicle(request)"));
});
