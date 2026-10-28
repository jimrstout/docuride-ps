// A top-level error with no contract number is a refusal, not an unknown
// (2026-10-28). Deal 15029's submit at 18:26 UTC reused a rate whose contract
// had been voided, and the answer was parked at Submit Status Unknown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readSubmitResponse } from "../supabase/functions/_shared/submit-outcome.ts";

const ASKED = [{ rateUniqueId: "34347", productName: "Sample Battery" }];
/** The answer, exactly as the provider sent it. */
const VOIDED = {
  error: " One or more of these products have been voided. Please re-rate and try again",
  contracts: [{ pdfLink: "RSAPI.ratessys-qa.com/final/", productId: 0, rateUniqueId: "34347" }],
};

test("the 15029 answer is a refusal, and never Submit Status Unknown", () => {
  const r = readSubmitResponse(VOIDED, ASKED, "Sample Provider");
  assert.equal(r.refusedOutright, true);
  assert.equal(r.unknown, false);
  assert.deepEqual(r.created, []);
  assert.equal(r.products[0].outcome, "Refused");
  assert.equal(r.products[0].detail, "One or more of these products have been voided. Please re-rate and try again");
  assert.equal(
    r.message,
    "Sample Provider did not create the contract. Sample Battery: not created. Sample Provider would not accept " +
      "Sample Battery: One or more of these products have been voided. Please re-rate and try again."
  );
  assert.doesNotMatch(r.message, /Submit Status Unknown|does not say/);
});

test("the provider's words are trimmed", () => {
  const r = readSubmitResponse({ error: "\n  Something went wrong.  \t", contracts: [{ productId: 0, rateUniqueId: "34347" }] }, ASKED, "Sample Provider");
  assert.equal(r.products[0].detail, "Something went wrong.");
  assert.match(r.message, /would not accept Sample Battery: Something went wrong\.$/);
});

test("a top-level error beside a real contract number still records the contract, and shows the error", () => {
  const r = readSubmitResponse(
    { error: "Partial failure ", contracts: [{ contractNumber: "MOCK-1", rateUniqueId: "34347", productId: 1, pdfLink: "x" }] },
    ASKED,
    "Sample Provider"
  );
  assert.equal(r.refusedOutright, false);
  assert.equal(r.unknown, false);
  assert.equal(r.created.length, 1);
  assert.equal(r.products[0].outcome, "Created");
  assert.match(r.message, /^Submitted\. Sample Provider created 1 contract\. Sample Battery: created, contract MOCK-1\. Sample Provider also said: Partial failure\.$/);
});

test("no error and no contract number is still Not known", () => {
  for (const answer of [{}, { contracts: [] }, { contracts: [{ productId: 0, rateUniqueId: "34347" }] }, { error: "   ", contracts: [{ productId: 0 }] }]) {
    const r = readSubmitResponse(answer, ASKED, "Sample Provider");
    assert.equal(r.unknown, true, JSON.stringify(answer));
    assert.equal(r.products[0].outcome, "Not known");
  }
});

test("a refusal hands the lock back and keeps the answer behind Show details", () => {
  const submit = readFileSync(new URL("../supabase/functions/fni-contract-submit/index.ts", import.meta.url), "utf8");
  // refusedOutright returns through refuse(), which releases the lock: never markUnknown.
  const block = submit.slice(submit.indexOf("if (reading.refusedOutright) {"), submit.indexOf("if (reading.created.length === 0) {"));
  assert.match(block, /await keepAnswer\("Submit refused", reading\.message\);/);
  assert.match(block, /return await refuse\(400, \{\s*error: reading\.message,/);
  assert.doesNotMatch(block, /markUnknown/);
  assert.match(submit, /const refuse = async \(status: number, body: Record<string, unknown>\) => \{\s*await releaseLock\(\);/);
});
