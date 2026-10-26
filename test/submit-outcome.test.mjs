// Partial success on submit (fix 4e). The answer is read product by product:
// every contract created is recorded, even under a top-level error, and what
// cannot be accounted for parks the session at Submit Status Unknown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readSubmitResponse } from "../supabase/functions/_shared/submit-outcome.ts";

const asked = [
  { rateUniqueId: "175724", productName: "Tire and Wheel" },
  { rateUniqueId: "34347", productName: "Battery Plus" },
  { rateUniqueId: "1448", productName: "Theft, Plan A" },
];

test("deal 13437: a reported failure with two contracts created records both", () => {
  const r = readSubmitResponse({
    error: "We ran into error while submitting your request.",
    contracts: [
      { rateUniqueId: "175724", productId: 1, error: "no rate found matching criteria" },
      { rateUniqueId: "34347", productId: 2, contractNumber: "BAT-1", pdfLink: "x" },
      { rateUniqueId: "1448", productId: 3, contractNumber: "THF-1", pdfLink: "y" },
    ],
  }, asked);
  assert.deepEqual(r.created.map((c) => c.contractNumber), ["BAT-1", "THF-1"]);
  assert.deepEqual(r.products.map((p) => p.outcome), ["Refused", "Created", "Created"]);
  assert.equal(r.refusedOutright, false);
  assert.equal(r.unknown, false);
  assert.match(r.message, /^TecAssured created 2 of 3 contracts\. Tire and Wheel: not created\. TecAssured would not accept Tire and Wheel: it has no rate/);
  assert.match(r.message, /Battery Plus: created, contract BAT-1\. Theft, Plan A: created, contract THF-1\.$/);
});

test("everything created reads as a plain success", () => {
  const r = readSubmitResponse({ contracts: asked.map((a, i) => ({ rateUniqueId: a.rateUniqueId, contractNumber: `C${i}` })) }, asked);
  assert.equal(r.created.length, 3);
  assert.equal(r.unknown, false);
  assert.match(r.message, /^Submitted\. TecAssured created 3 contracts\./);
});

test("a clear no for every product hands the lock back", () => {
  const all = readSubmitResponse({ error: "We ran into error", contracts: asked.map((a) => ({ rateUniqueId: a.rateUniqueId, error: "Failed to submit" })) }, asked);
  assert.equal(all.refusedOutright, true);
  assert.equal(all.created.length, 0);
  const whole = readSubmitResponse({ error: "Missing Dealer Code." }, asked.slice(0, 1));
  assert.equal(whole.refusedOutright, true);
  assert.match(whole.message, /^TecAssured did not create the contract\. Tire and Wheel: not created\. TecAssured would not accept Tire and Wheel: Missing Dealer Code\.$/);
});

test("a product the answer does not mention is Not known, and so is the session", () => {
  const r = readSubmitResponse({ error: "We ran into error", contracts: [{ rateUniqueId: "34347", contractNumber: "BAT-1" }] }, asked);
  assert.deepEqual(r.products.map((p) => p.outcome), ["Not known", "Created", "Not known"]);
  assert.equal(r.unknown, true);
  assert.equal(r.created.length, 1);
  assert.match(r.message, /Tire and Wheel: TecAssured's answer does not say whether this contract was created\./);
  assert.match(r.message, /marked Submit Status Unknown: check TecAssured/);
});

test("no way to tell at all is Submit Status Unknown, never nothing", () => {
  for (const response of [{}, { contracts: [] }, { contracts: [{ rateUniqueId: "34347" }] }, null]) {
    const r = readSubmitResponse(response, asked);
    assert.equal(r.unknown, true);
    assert.equal(r.refusedOutright, false);
    assert.equal(r.created.length, 0);
  }
});

test("a contract number matching nothing we sent is reported, and makes it Not known", () => {
  const r = readSubmitResponse({ contracts: [
    ...asked.map((a, i) => ({ rateUniqueId: a.rateUniqueId, contractNumber: `C${i}` })),
    { rateUniqueId: "999", contractNumber: "STRAY-1" },
  ] }, asked);
  assert.deepEqual(r.untied, ["STRAY-1"]);
  assert.equal(r.unknown, true);
  assert.equal(r.created.length, 3);
  assert.match(r.message, /cannot match to a product we sent: STRAY-1\./);
});

test("submit records what was created and parks the lock only when something is not known", () => {
  const sub = readFileSync(new URL("../supabase/functions/fni-contract-submit/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(sub, /if \(response\.error && String\(response\.error\)\.trim\(\) !== ""\)/);
  assert.match(sub, /if \(reading\.refusedOutright\) \{[\s\S]*?return await refuse\(400, \{\s+error: reading\.message,/);
  assert.match(sub, /if \(reading\.created\.length === 0\) \{[\s\S]*?await markUnknown\(reading\.message\);/);
  assert.match(sub, /const contracts = reading\.created;/);
  assert.match(sub, /if \(reading\.unknown\) await markUnknown\(reading\.message\);\s+else await releaseLock\(\);/);
  assert.match(sub, /products: reading\.products,\s+partial:/);
});
