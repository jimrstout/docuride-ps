// The signature data from /contract/document is stored exactly as returned,
// and a type other than buyer and seller (such as "cobuyer") is reported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { otherSignatureTypes, signatureData } from "../supabase/functions/_shared/contract-documents.ts";

const today = [
  { page: 1, type: "buyer", left: 233.238, top: 112.558, right: 386.566, bottom: 90.808 },
  { page: 1, type: "seller", left: 188.238, top: 78.808, right: 341.566, bottom: 57.058 },
];

test("the signature data is kept untouched, whatever its shape", () => {
  assert.equal(signatureData({ signatures: today }), today);
  const single = { page: 1, type: "buyer" };
  assert.equal(signatureData({ signature: single }), single);
  assert.equal(signatureData({ data: "JVBERi0" }), null);
});

test("buyer and seller are the known types; anything else is reported", () => {
  assert.deepEqual(otherSignatureTypes(today), []);
  assert.deepEqual(otherSignatureTypes([...today, { page: 1, type: "cobuyer", left: 1 }]), ["cobuyer"]);
  assert.deepEqual(otherSignatureTypes([{ type: "Buyer" }, { type: "SELLER" }, { type: "Co-Buyer" }, { type: "Co-Buyer" }]), ["Co-Buyer"]);
  // Keyed by type rather than listed.
  assert.deepEqual(otherSignatureTypes({ buyer: { page: 1 }, seller: { page: 1 }, cobuyer: { page: 1 } }), ["cobuyer"]);
  assert.deepEqual(otherSignatureTypes(null), []);
  assert.deepEqual(otherSignatureTypes("nonsense"), []);
});

test("fni-contract-documents stores it as returned and reports new types", () => {
  const fn = readFileSync(new URL("../supabase/functions/fni-contract-documents/index.ts", import.meta.url), "utf8");
  assert.match(fn, /provider_signatures: signatureData\(doc\),/);
  assert.match(fn, /result\.other_signature_types = otherSignatureTypes\(result\.signatures\);/);
  assert.match(fn, /other_signature_types: results\s+\.filter/);
});
