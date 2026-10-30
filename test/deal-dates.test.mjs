// Dates are always sent and never invented (_shared/deal-dates.ts).
//
// Deal 15029, a New MCYC, was refused with "The value '' cannot be parsed as
// the type 'DateTime'": MCYC does not list inservice.date, so none was sent.
// And a missing sale date used to become today.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  alignContractDates, dealDates, fromTecAssuredDate, isoDate, tecAssuredDate,
  IN_SERVICE_DATE_MISSING, SALE_DATE_MISSING,
} from "../supabase/functions/_shared/deal-dates.ts";
import { parseRequiredProperties } from "../supabase/functions/_shared/rate-properties.ts";
import { buildRateRequest } from "../supabase/functions/_shared/rate-request.ts";
import { buildVerification } from "../supabase/functions/_shared/verification.ts";
import { crmRatingFields } from "../supabase/functions/_shared/crm-fields.ts";
import { mapSession } from "../supabase/functions/_shared/session-map.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const TODAY = new Date().toISOString().split("T")[0];

const p = (property, label = property, dataType = "STRING") => ({ property, label, dataType, required: true, description: label });
const MCYC = parseRequiredProperties({
  properties: [
    p("year"), p("vin"), p("model"), p("make"), p("fuel.type"), p("engine.ccs"),
    p("finance.amount"), p("finance.apr"), p("finance.term"), p("odometer"), p("price"),
    p("new.used"), p("finance.type"), p("warranty"), p("sale.date", "Sale Date", "DATE"), p("postal.code"),
  ],
}).properties;

const indian = (over = {}) => ({
  vin: "TESTVIN0000015029", unit_year: 2026, unit_make: "Indian", unit_model: "Pursuit",
  condition: "New", odometer: 3, sale_price: 30000, amount_financed: 28000, apr: 7.99,
  finance_term: 60, finance_type: "Loan", sale_date: "2026-10-20", in_service_date: null,
  buyer_zip: "26101", buyer_city: "Parkersburg", buyer_state: "WV",
  vehicle_properties: { "engine.ccs": "1768", "fuel.type": "Gas", warranty: "24" },
  ...over,
});
const opts = { dealerCode: "3-306", vtype: "MCYC" };
const props = (req) => Object.fromEntries(req.properties.map((x) => [x.name, x.value]));

test("a New MCYC request carries inservice.date, the sale date, in both halves", () => {
  const { request, dateProblem } = buildRateRequest(MCYC, indian(), opts);
  assert.equal(dateProblem, null);
  assert.equal(props(request)["inservice.date"], "2026-10-20");
  assert.equal(props(request)["sale.date"], "2026-10-20");
  assert.equal(request.saleDate, "2026-10-20");
  assert.equal(request.inServiceDate, "2026-10-20");
  assert.equal(request.vehiclePurchaseDate, "2026-10-20");
});

test("a recorded in-service date is the one sent", () => {
  const { request } = buildRateRequest(MCYC, indian({ condition: "Used", in_service_date: "2024-05-01" }), opts);
  assert.equal(props(request)["inservice.date"], "2024-05-01");
  assert.equal(request.inServiceDate, "2024-05-01");
  assert.equal(request.saleDate, "2026-10-20");
});

test("a Used unit with no in-service date is refused, in plain English", () => {
  const { request, dateProblem } = buildRateRequest(MCYC, indian({ condition: "Used" }), opts);
  assert.equal(dateProblem, IN_SERVICE_DATE_MISSING);
  assert.equal("inServiceDate" in request, false);
  assert.equal("inservice.date" in props(request), false);
  assert.equal(dealDates({ sale_date: "2026-10-20", in_service_date: null, condition: "Used" }).inService, null);
});

test("a deal with no sale date is refused, and today is never put in its place", () => {
  for (const sale of [null, "", "not a date"]) {
    const { request, dateProblem } = buildRateRequest(MCYC, indian({ sale_date: sale }), opts);
    assert.equal(dateProblem, SALE_DATE_MISSING);
    for (const k of ["saleDate", "vehiclePurchaseDate", "inServiceDate"]) assert.notEqual(request[k], TODAY, k);
    assert.equal("sale.date" in props(request), false);
  }
  assert.equal(SALE_DATE_MISSING, "There is no sale date in the CRM. Add the Sale Date in the CRM.");
});

test("rateDate is still today: it says when we asked, not anything about the deal", () => {
  assert.equal(buildRateRequest(MCYC, indian(), opts).request.rateDate, TODAY);
  assert.equal(buildRateRequest(MCYC, indian(), { ...opts, rateDate: "2026-09-25" }).request.rateDate, "2026-09-25");
});

test("no code path produces today for a deal date", () => {
  // The only new Date() in the date code is rateDate's.
  const rr = src("../supabase/functions/_shared/rate-request.ts");
  assert.equal((rr.match(/new Date\(\)/g) ?? []).length, 1);
  assert.match(rr, /rateDate: opts\.rateDate \?\? new Date\(\)\.toISOString\(\)\.split\("T"\)\[0\],/);
  assert.doesNotMatch(src("../supabase/functions/_shared/deal-dates.ts"), /new Date\(\)|Date\.now\(\)/);
  assert.doesNotMatch(src("../supabase/functions/_shared/price-sheet-rows.ts"), /new Date\(\)/);
  assert.doesNotMatch(src("../supabase/functions/_shared/adapters/price-sheet.ts"), /new Date\(\)/);
  // And none of the old fallbacks survive anywhere in the functions.
  const all = readdirSync(new URL("../supabase/functions/_shared/", import.meta.url))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => src(`../supabase/functions/_shared/${f}`))
    .join("\n") + src("../supabase/functions/fni-contract-submit/index.ts");
  assert.doesNotMatch(all, /sale_date\)? \?\? today|saleDate \?\? new Date|\?\? today\b/);
});

test("the dates are read as days, and nonsense is not a date", () => {
  assert.equal(isoDate("2026-10-20"), "2026-10-20");
  assert.equal(isoDate("2026-10-20T23:59:59Z"), "2026-10-20");
  assert.equal(isoDate("Sep 6, 2026"), "2026-09-06");
  assert.equal(isoDate("2026-02-30"), null);
  assert.equal(isoDate(""), null);
  assert.equal(isoDate(null), null);
});

test("the Verify sheet needs both dates for every vehicle type, in plain English", () => {
  const base = indian({ condition: "Used", vehicle_type: "On-Road Motorcycle", vehicle_type_code: "MCYC" });
  const sheet = buildVerification(base, []); // nothing listed by TecAssured at all
  const f = (k) => sheet.fields.find((x) => x.key === k);
  assert.equal(f("sale_date").required, true);
  assert.equal(f("in_service_date").required, true);
  assert.equal(f("in_service_date").missing, true);
  assert.equal(f("in_service_date").note, IN_SERVICE_DATE_MISSING);
  const noSale = buildVerification(indian({ sale_date: null }), []);
  assert.equal(noSale.fields.find((x) => x.key === "sale_date").missing, true);
  assert.equal(noSale.fields.find((x) => x.key === "sale_date").note, SALE_DATE_MISSING);
  // A New unit's in-service date is its sale date.
  assert.equal(buildVerification(indian(), []).fields.find((x) => x.key === "in_service_date").value, "2026-10-20");
});

test("the CRM mappings give a used unit no in-service date", () => {
  const rec = (cond) => ({ id: "1", Name: "15029", Sale_Date: "2026-10-20", Sold_1_Condition: cond });
  assert.equal(crmRatingFields(rec("New")).in_service_date, "2026-10-20");
  assert.equal(crmRatingFields(rec("Used")).in_service_date, null);
  assert.equal(mapSession(rec("New"), "s", "t", null, null, "x").in_service_date, "2026-10-20");
  assert.equal(mapSession(rec("Used"), "s", "t", null, null, "x").in_service_date, null);
});

test("a contract's dates are made the session's, in TecAssured's own format", () => {
  assert.equal(fromTecAssuredDate("Sep 6, 2026, 6:53:44 PM"), "2026-09-06");
  assert.equal(tecAssuredDate("2026-09-06"), "Sep 6, 2026, 12:00:00 PM");
  const quote = {
    saleDate: "Oct 26, 2026, 6:53:44 PM",
    vehicles: [{ form: { properties: [
      { property: "sale.date", value: "2026-10-26", dataType: "DATE" },
      { property: "inservice.date", value: "2026-10-26", dataType: "STRING" },
      { property: "vin", value: "X" },
    ] } }],
  };
  const changed = alignContractDates(quote, { sale: "2026-09-06", inService: "2024-05-01" });
  assert.equal(quote.saleDate, "Sep 6, 2026, 6:53:44 PM");
  assert.equal(quote.vehicles[0].form.properties[0].value, "2026-09-06");
  assert.equal(quote.vehicles[0].form.properties[1].value, "2024-05-01");
  assert.equal(quote.vehicles[0].form.properties[2].value, "X");
  assert.equal(changed.length, 3);
  // Already right: nothing changes, nothing is added.
  const same = { saleDate: "Sep 6, 2026, 6:53:44 PM", vehicles: [{ form: { properties: [{ property: "sale.date", value: "2026-09-06" }] } }] };
  assert.deepEqual(alignContractDates(same, { sale: "2026-09-06", inService: "2026-09-06" }), []);
  assert.equal(same.vehicles[0].form.properties.length, 1);
});

test("submit refuses on a bad date and aligns the quote before sending", () => {
  const sub = src("../supabase/functions/fni-contract-submit/index.ts");
  const refuse = sub.indexOf("if (dates.problem || dates.sale === null || dates.inService === null)");
  const align = sub.indexOf("alignContractDates(submitQuote,");
  const call = sub.indexOf("await client.submitContractDetailed(submitPayload)");
  assert.ok(refuse > 0 && refuse < align && align < call);
  assert.match(sub, /dealDates\(applyStaffEdits\(session as Record<string, unknown>, parseStaffEdits\(session\.staff_edits\)\)\)/);
});

test("the TecAssured adapter and the price sheet path stop on a bad date before asking", () => {
  const ad = src("../supabase/functions/_shared/adapters/tecassured.ts");
  assert.ok(ad.indexOf("if (built.dateProblem) return") < ad.indexOf("store.client.rateVehicle(request)"));
  const rs = src("../supabase/functions/_shared/rate-session.ts");
  assert.ok(rs.indexOf("if (dates.problem || !deal.sale_date)") < rs.indexOf("publishedSheetFor(supabase, provider.id, deal.sale_date)"));
});
