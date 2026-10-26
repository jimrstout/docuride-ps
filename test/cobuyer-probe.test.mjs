// TEMPORARY: the co-buyer field probe. Delete with _shared/cobuyer-probe.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BATCHES, QUOTE_VARIANTS, ROOT_VARIANTS, applyCobuyerProbe, markerTable, parseProbeBatch, probeAllows, probeDecision,
} from "../supabase/functions/_shared/cobuyer-probe.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("41 quote variants and 3 top-level ones, each with its own marker", () => {
  assert.equal(QUOTE_VARIANTS.length, 41);
  assert.equal(ROOT_VARIANTS.length, 3);
  const markers = [...QUOTE_VARIANTS, ...ROOT_VARIANTS].map((v) => v.marker);
  assert.equal(new Set(markers).size, markers.length);
  assert.deepEqual(QUOTE_VARIANTS.map((v) => v.marker), Array.from({ length: 41 }, (_, i) => `CB${String(i + 1).padStart(2, "0")}`));
  assert.deepEqual(ROOT_VARIANTS.map((v) => v.marker), ["R01", "R02", "R03"]);
});

test("the batches are CB01-12, CB13-25, and CB26-41 with R01-03, covering everything once", () => {
  assert.deepEqual(BATCHES[1].map((v) => v.marker), QUOTE_VARIANTS.slice(0, 12).map((v) => v.marker));
  assert.deepEqual(BATCHES[2].map((v) => v.marker), QUOTE_VARIANTS.slice(12, 25).map((v) => v.marker));
  assert.deepEqual(BATCHES[3].map((v) => v.marker), [...QUOTE_VARIANTS.slice(25).map((v) => v.marker), "R01", "R02", "R03"]);
  assert.equal(BATCHES[1].length + BATCHES[2].length + BATCHES[3].length, 44);
});

test("every variant carries its marker in first and last name; full names carry it twice", () => {
  const quote = { buyerFirstName: "REAL", buyerLastName: "BUYER", products: [] };
  const payload = { dealerCode: "3-306", quote };
  const rows = applyCobuyerProbe(quote, payload, "All");
  assert.equal(rows.length, 44);
  assert.equal(quote.coBuyerFirstName, "CB01");
  assert.equal(quote.coBuyerLastName, "CB01");
  assert.equal(quote.coBuyer_FirstName, "CB07");
  assert.equal(quote["co-buyer-last-name"], "CB10");
  assert.equal(quote.coBuyerName, "CB26 CB26");
  assert.equal(quote.coBuyerFullName, "CB29 CB29");
  assert.deepEqual(quote.coBuyer, { firstName: "CB30", lastName: "CB30" });
  assert.deepEqual(quote.CoBuyer, { FirstName: "CB32", LastName: "CB32" });
  assert.deepEqual(quote["co-buyer"], { firstName: "CB33", lastName: "CB33" });
  assert.equal(quote.owner2LastName, "CB41");
  assert.equal(payload.coBuyerFirstName, "R01");
  assert.equal(payload.CoBuyerLastName, "R02");
  assert.deepEqual(payload.coBuyer, { firstName: "R03", lastName: "R03" });
  // The real buyer and the payload's own keys are untouched; no arrays.
  assert.equal(quote.buyerFirstName, "REAL");
  assert.equal(payload.dealerCode, "3-306");
  assert.ok(!("buyers" in quote) && !("customers" in quote) && !("buyers" in payload) && !("customers" in payload));
  // Every value is a marker: no names, no CRM data.
  const values = JSON.stringify([...Object.entries(quote), ...Object.entries(payload)].filter(([k]) => !["buyerFirstName", "buyerLastName", "products", "dealerCode", "quote"].includes(k)));
  assert.doesNotMatch(values.replace(/CB\d\d|R0\d|firstName|lastName|FirstName|LastName/g, ""), /[A-Za-z]{3,}[^"]*":/);
});

test("a batch adds only its own variants", () => {
  const quote = {}; const payload = {};
  applyCobuyerProbe(quote, payload, 2);
  assert.equal(quote.coFirstname, "CB13");
  assert.equal(quote.coPurchaserLastName, "CB25");
  assert.ok(!("coBuyerFirstName" in quote) && !("coBuyerName" in quote));
  assert.deepEqual(Object.keys(payload), []);
});

test("the probe never overwrites a key that is already there", () => {
  assert.throws(() => applyCobuyerProbe({ coBuyerName: "x" }, {}, "All"), /would overwrite coBuyerName, so nothing was sent/);
});

test("the marker table lists markers and field names only", () => {
  const t = markerTable("All");
  assert.deepEqual(t[0], { marker: "CB01", level: "Quote", fields: "coBuyerFirstName / coBuyerLastName", sent: "CB01 / CB01" });
  assert.deepEqual(t[25], { marker: "CB26", level: "Quote", fields: "coBuyerName", sent: "CB26 CB26" });
  assert.deepEqual(t[43], { marker: "R03", level: "Top level", fields: "coBuyer: { firstName, lastName }", sent: "{ R03, R03 }" });
});

test("batch values", () => {
  for (const v of [undefined, null, "", "All"]) assert.equal(parseProbeBatch(v), "All");
  assert.equal(parseProbeBatch(2), 2);
  assert.equal(parseProbeBatch("3"), 3);
  assert.equal(parseProbeBatch("Batch 1"), 1);
  assert.equal(parseProbeBatch(4), null);
  assert.equal(parseProbeBatch("x"), null);
});

test("only Battery Standard and Care forms may carry it", () => {
  for (const p of ["RA BATTERY STANDARD USED", "USED ON-ROAD CARE", "USED ATV/UTV CARE-SVC DRIVE"]) assert.equal(probeAllows(p), true, p);
  for (const p of ["RA BATTERY PLUS USED", "RIDER'S ADVANTAGE T&W ON-ROAD", "USED BRONZE ON-ROAD NON-EU", "RA THEFT PLAN A", null]) assert.equal(probeAllows(p), false, String(p));
});

test("the flag is ignored unless test session, past the guard, and asked for", () => {
  const products = [{ name: "RA BATTERY STANDARD USED - RA", program: "RA BATTERY STANDARD USED" }];
  assert.deepEqual(probeDecision({ requested: true, batch: "All", isTest: true, guardPassed: true, products }), { kind: "On", batch: "All" });
  assert.deepEqual(probeDecision({ requested: true, batch: "All", isTest: false, guardPassed: true, products }), { kind: "Off" });
  assert.deepEqual(probeDecision({ requested: true, batch: "All", isTest: true, guardPassed: false, products }), { kind: "Off" });
  assert.deepEqual(probeDecision({ requested: "true", batch: "All", isTest: true, guardPassed: true, products }), { kind: "Off" });
  assert.deepEqual(probeDecision({ requested: undefined, batch: 9, isTest: true, guardPassed: true, products: [] }), { kind: "Off" });
});

test("asked for with another product, the submit is refused in plain English", () => {
  const d = probeDecision({
    requested: true, batch: "All", isTest: true, guardPassed: true,
    products: [
      { name: "RA BATTERY STANDARD USED - RA", program: "RA BATTERY STANDARD USED" },
      { name: "RIDER'S ADVANTAGE T&W ON-ROAD - RA", program: "RIDER'S ADVANTAGE T&W ON-ROAD" },
    ],
  });
  assert.equal(d.kind, "Refuse");
  assert.match(d.message, /^The co-buyer field test only works on Battery Standard or Care Coverage, the forms that print a co-buyer name\. RIDER'S ADVANTAGE T&W ON-ROAD - RA is also selected, so nothing was sent\./);
  assert.equal(probeDecision({ requested: true, batch: 7, isTest: true, guardPassed: true, products: [] }).kind, "Refuse");
});

test("submit applies it after the buyer, records it first, and returns refusals verbatim", () => {
  const sub = src("../supabase/functions/fni-contract-submit/index.ts");
  const step5 = sub.indexOf("// ── Step 5: Buyer and lienholder");
  const apply = sub.indexOf("probeMarkers = applyCobuyerProbe(submitQuote, submitPayload, probe.batch);");
  const event = sub.indexOf('event: "Co-buyer field probe sent",');
  const call = sub.indexOf("await client.submitContract(submitPayload)");
  assert.ok(step5 > 0 && step5 < apply && apply < event && event < call);
  assert.match(sub, /guardPassed: notCleared === null,/);
  assert.match(sub, /error: verbatim\.length > 0 \? verbatim\.join\(" \| "\) : JSON\.stringify\(response\),/);
  // Nothing retries, strips or switches batches.
  assert.equal((sub.match(/applyCobuyerProbe\(/g) ?? []).length, 1);
  assert.equal((sub.match(/client\.submitContract\(/g) ?? []).length, 1);
});
