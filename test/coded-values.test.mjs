// Coded values: every field the provider codes goes out as its code, read from
// the provider's form, and a word with no code stops the rating in plain
// English (_shared/coded-values.ts, migration 0051).
//
// Probes on deal 15063 (fni.rate_probes, 2026-11-02): new.used "N" brought the
// New programs, finance.type "F" brought GAP; the words "New" and "Loan" were
// ignored. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  codeFor,
  codeRequest,
  DOCUMENTED_CODES,
  formCodesFromQuote,
  noCodeMessage,
} from "../supabase/functions/_shared/coded-values.ts";
import { buildRateRequest } from "../supabase/functions/_shared/rate-request.ts";

// A quote's form as the provider sends it, trimmed, with made-up values.
const QUOTE = {
  quote: { vehicles: [{ form: { properties: [
    { property: "fuel.type", value: "G", extension: { values: [{ key: "G", value: "Gasoline" }, { key: "E", value: "Electric" }, { key: "D", value: "Diesel" }] } },
    { property: "year", value: "2026", extension: { values: [{ key: "", value: "" }] } },
    { property: "make", value: "Sample Make", extension: { values: [{ key: "", value: "" }] } },
    { property: "new.used", value: "New", extension: { values: [{ key: "N", value: "New" }, { key: "U", value: "Used" }] } },
    { property: "finance.type", value: "Loan", extension: { values: [{ key: "N", value: "None" }, { key: "F", value: "Loan" }, { key: "B", value: "Balloon" }, { key: "L", value: "Lease" }] } },
    { property: "odometer", value: "3" },
  ] } }] },
};
const FORM = formCodesFromQuote(QUOTE);

const REQUIRED = ["vin", "year", "make", "model", "new.used", "odometer", "price", "finance.type", "finance.amount",
  "finance.apr", "finance.term", "sale.date", "postal.code", "fuel.type", "engine.ccs", "warranty"].map((name) => ({ name }));
const DEAL = {
  vin: "SAMPLEVIN0000001", unit_year: 2026, unit_make: "Sample Make", unit_model: "Sample Model", condition: "New",
  odometer: 3, sale_price: 12999, finance_type: "Loan", amount_financed: 11000, apr: 6.99, finance_term: 60,
  finance_term_total: 60, sale_date: "2026-11-01", buyer_zip: "83702", buyer_city: "Boise", buyer_state: "ID",
  vehicle_properties: { "engine.ccs": "976", warranty: "24", "fuel.type": "Gasoline" },
};
const sent = (over = {}, form = FORM) => {
  const built = buildRateRequest(REQUIRED, { ...DEAL, ...over }, { dealerCode: "0-000", vtype: "ATV", formCodes: form, rateDate: "2026-11-02" });
  const prop = (n) => built.request.properties.find((p) => p.name === n)?.value;
  return { built, prop };
};

test("the form's coded fields are read from the quote; free-text fields are not coded", () => {
  assert.deepEqual(Object.keys(FORM).sort(), ["finance.type", "fuel.type", "new.used"]);
  assert.deepEqual(FORM["new.used"], [{ key: "N", value: "New" }, { key: "U", value: "Used" }]);
  assert.equal(formCodesFromQuote({ quote: { vehicles: [{}] } }), null);
  assert.equal(formCodesFromQuote(null), null);
});

test("New sends N and Used sends U, in both halves of the request", () => {
  const n = sent({ condition: "New" });
  assert.deepEqual([n.built.request.purchaseType, n.built.request.vehicleStatus, n.prop("new.used")], ["N", "N", "N"]);
  const u = sent({ condition: "Used" });
  assert.deepEqual([u.built.request.purchaseType, u.built.request.vehicleStatus, u.prop("new.used")], ["U", "U", "U"]);
});

test("Loan sends F and Cash sends N for finance.type", () => {
  const loan = sent({ finance_type: "Loan" });
  assert.deepEqual([loan.built.request.financeType, loan.prop("finance.type")], ["F", "F"]);
  const cash = sent({ finance_type: "Cash" });
  assert.deepEqual([cash.built.request.financeType, cash.prop("finance.type")], ["N", "N"]);
  // Fuel stays its code.
  assert.deepEqual([loan.built.request.fuelType, loan.prop("fuel.type")], ["G", "G"]);
  assert.equal(loan.built.codeProblem, null);
});

test("an unmapped value blocks rating with a plain-English message naming the field", () => {
  // A form that lists no Balloon, and a deal that is one.
  const noBalloon = { ...FORM, "finance.type": FORM["finance.type"].filter((c) => c.value !== "Balloon") };
  const { built } = sent({ finance_type: "Balloon" }, noBalloon);
  assert.equal(built.codeProblem, 'Your provider has no code for Deal type "Balloon", so rating was stopped rather than sending a value it would ignore. Check Deal type on Verify.');
  assert.equal(noCodeMessage("new.used", "Demo"), 'Your provider has no code for New or Used "Demo", so rating was stopped rather than sending a value it would ignore. Check New or Used on Verify.');
  assert.deepEqual(codeRequest({ purchaseType: "Demo", properties: [] }, FORM), { problem: noCodeMessage("new.used", "Demo") });
  // The adapter stops on it before anything is sent.
  const adapter = readFileSync(new URL("../supabase/functions/_shared/adapters/tecassured.ts", import.meta.url), "utf8");
  assert.ok(adapter.indexOf("if (built.codeProblem) return { state: \"Failed\", reason: built.codeProblem };") < adapter.indexOf("store.client.rateVehicle(request)"));
});

test("until the form has been seen, the documented codes are used", () => {
  const { built, prop } = sent({}, null);
  assert.deepEqual([built.request.purchaseType, built.request.financeType, prop("new.used"), prop("finance.type")], ["N", "F", "N", "F"]);
  assert.deepEqual(DOCUMENTED_CODES["finance.type"].map((c) => c.key), ["N", "F", "B", "L"]);
  // A value that is already a code stays as it is; matching ignores case.
  assert.equal(codeFor(FORM["fuel.type"], "G"), "G");
  assert.equal(codeFor(FORM["new.used"], "used"), "U");
});

test("each rating keeps what the form stated, for the next one; screens keep the words", () => {
  const adapter = readFileSync(new URL("../supabase/functions/_shared/adapters/tecassured.ts", import.meta.url), "utf8");
  assert.match(adapter, /const stated = formCodesFromQuote\(response\);/);
  assert.match(adapter, /\.update\(\{ form_codes: stated, form_codes_at: new Date\(\)\.toISOString\(\) \}\)/);
  assert.match(adapter, /formCodes,\n\s*\}\);/);
  // The request's words come from the session as before: the session and the
  // screens say New and Loan, never N or F.
  const rr = readFileSync(new URL("../supabase/functions/_shared/rate-request.ts", import.meta.url), "utf8");
  assert.match(rr, /if \(lower === "new"\) return "New";/);
  assert.match(rr, /if \(lower === "loan" \|\| lower === "finance" \|\| lower === "purchase"\) return "Loan";/);
});
