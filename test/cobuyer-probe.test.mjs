// TEMPORARY: the co-buyer field probe. Delete with _shared/cobuyer-probe.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BATCHES, QUOTE_VARIANTS, ROOT_VARIANTS, applyCobuyerProbe, markerTable, parseProbeBatch, probeAllows, probeDecision,
} from "../supabase/functions/_shared/cobuyer-probe.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// Round 2 (2026-10-28): the phone field, and CB03 again.
const PHONES = [
  ["P01", "buyerPhone"], ["P02", "buyerPhoneNumber"], ["P03", "buyerTelephone"], ["P04", "buyerHomePhone"],
  ["P05", "buyerCellPhone"], ["P06", "buyerMobilePhone"], ["P07", "buyerMobile"], ["P08", "buyerPhone1"],
  ["P09", "buyerDayPhone"], ["P10", "buyerWorkPhone"], ["P11", "BuyerPhone"], ["P12", "buyerphone"],
  ["P13", "buyer_phone"], ["P14", "phone"], ["P15", "phoneNumber"], ["P16", "telephone"],
  ["P17", "customerPhone"], ["P18", "contactPhone"], ["P19", "buyerPrimaryPhone"], ["P20", "buyerEveningPhone"],
];

test("twenty phone guesses and CB03, all on the quote, none at the top level", () => {
  assert.deepEqual(QUOTE_VARIANTS.map((v) => v.marker), [...PHONES.map(([m]) => m), "CB03"]);
  assert.equal(ROOT_VARIANTS.length, 0);
  assert.ok(QUOTE_VARIANTS.every((v) => v.level === "Quote"));
});

test("each phone key carries a digits-only 304-555-01xx number named by its last two digits", () => {
  const quote = { buyerFirstName: "REAL", buyerLastName: "BUYER", products: [] };
  const payload = { dealerCode: "3-306", quote };
  const rows = applyCobuyerProbe(quote, payload, "All");
  assert.equal(rows.length, 21);
  for (const [m, key] of PHONES) {
    assert.equal(quote[key], `30455501${m.slice(1)}`, key);
    assert.match(quote[key], /^\d{10}$/);
  }
  assert.equal(quote.buyerPhone, "3045550101");
  assert.equal(quote.buyerEveningPhone, "3045550120");
  assert.equal(quote.cobuyerFirstName, "CB03");
  assert.equal(quote.cobuyerLastName, "CB03");
  // The real buyer and the payload's own keys are untouched; nothing at the top level; no arrays.
  assert.equal(quote.buyerFirstName, "REAL");
  assert.deepEqual(Object.keys(payload), ["dealerCode", "quote"]);
  assert.ok(!("buyers" in quote) && !("customers" in quote) && !("buyers" in payload) && !("customers" in payload));
});

test("the batches split the phones in two, each with CB03; batch 3 is CB03 alone", () => {
  assert.deepEqual(BATCHES[1].map((v) => v.marker), [...PHONES.slice(0, 10).map(([m]) => m), "CB03"]);
  assert.deepEqual(BATCHES[2].map((v) => v.marker), [...PHONES.slice(10).map(([m]) => m), "CB03"]);
  assert.deepEqual(BATCHES[3].map((v) => v.marker), ["CB03"]);
});

test("the probe never overwrites a key that is already there", () => {
  assert.throws(() => applyCobuyerProbe({ phone: "x" }, {}, "All"), /would overwrite phone, so nothing was sent/);
});

test("the marker table lists markers, field names and the made-up numbers only", () => {
  const t = markerTable("All");
  assert.deepEqual(t[0], { marker: "P01", level: "Quote", fields: "buyerPhone", sent: "3045550101" });
  assert.deepEqual(t[19], { marker: "P20", level: "Quote", fields: "buyerEveningPhone", sent: "3045550120" });
  assert.deepEqual(t[20], { marker: "CB03", level: "Quote", fields: "cobuyerFirstName / cobuyerLastName", sent: "CB03 / CB03" });
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
  assert.match(d.message, /^The field test only works on Battery Standard or Care Coverage, the forms that print a co-buyer name\. RIDER'S ADVANTAGE T&W ON-ROAD - RA is also selected, so nothing was sent\./);
  assert.equal(probeDecision({ requested: true, batch: 7, isTest: true, guardPassed: true, products: [] }).kind, "Refuse");
});

test("submit applies it after the buyer, records it first, and returns refusals verbatim", () => {
  const sub = src("../supabase/functions/fni-contract-submit/index.ts");
  const step5 = sub.indexOf("// ── Step 5: Buyer and lienholder");
  const apply = sub.indexOf("probeMarkers = applyCobuyerProbe(submitQuote, submitPayload, probe.batch);");
  const event = sub.indexOf('event: "Co-buyer field probe sent",');
  const call = sub.indexOf("await client.submitContractDetailed(submitPayload)");
  assert.ok(step5 > 0 && step5 < apply && apply < event && event < call);
  assert.match(sub, /guardPassed: notCleared === null,/);
  assert.match(sub, /error: verbatim\.length > 0 \? verbatim\.join\(" \| "\) : JSON\.stringify\(response\),/);
  // Nothing retries, strips or switches batches.
  assert.equal((sub.match(/applyCobuyerProbe\(/g) ?? []).length, 1);
  assert.equal((sub.match(/client\.submitContractDetailed\(/g) ?? []).length, 1);
});
