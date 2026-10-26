// Test contracts go only to TecAssured's QA server, and only for deal 13759 or
// a test session. Deal 14957 is never sent. See _shared/contract-guard.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contractCallRefusal, hostOf } from "../supabase/functions/_shared/contract-guard.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const QA = "https://ratessys-qa.com/rs/";

test("deal 13759 and test sessions may use the QA server", () => {
  assert.equal(contractCallRefusal({ deal_number: "13759", is_test: false }, QA, "submitted"), null);
  assert.equal(contractCallRefusal({ deal_number: "20001", is_test: true }, QA, "submitted"), null);
  assert.equal(hostOf("https://RATESSYS-QA.com/rs"), "ratessys-qa.com");
});

test("anything but the QA server is refused, for every deal", () => {
  for (const url of ["https://ratessys.com/rs/", "https://ratessys-qa.com.evil.example/", "not a url", null]) {
    assert.match(contractCallRefusal({ deal_number: "13759", is_test: true }, url, "voided"), /only be voided on the TecAssured test server/);
  }
});

test("deal 14957 is never sent, even as a test session; other deals need is_test", () => {
  assert.equal(
    contractCallRefusal({ deal_number: "14957", is_test: true }, QA, "submitted"),
    "Deal 14957 is not cleared for test contracts, so nothing was sent."
  );
  assert.match(contractCallRefusal({ deal_number: "13437", is_test: false }, QA, "fetched"), /Deal 13437 is neither/);
});

test("submit, documents and void each check before calling TecAssured", () => {
  const submit = src("../supabase/functions/fni-contract-submit/index.ts");
  const guard = submit.indexOf('contractCallRefusal(session, credentials.api_base_url, "submitted")');
  assert.ok(guard > 0 && guard < submit.indexOf("client.submitContract") && guard < submit.indexOf("buildSubmitQuote("));
  assert.match(submit, /if \(notCleared\) return await refuse\(403, \{ error: notCleared \}\);/);
  for (const [f, verb, call] of [
    ["../supabase/functions/fni-contract-documents/index.ts", "fetched", "client.getContractDocument"],
    ["../supabase/functions/fni-contract-void/index.ts", "voided", "client.voidContract"],
  ]) {
    const body = src(f);
    const at = body.indexOf(`contractCallRefusal(session, store.credentials.api_base_url, "${verb}")`);
    assert.ok(at > 0 && at < body.indexOf(call), f);
  }
  assert.match(src("../docs/multi-provider.md"), /Lift the QA-only contract rule/);
});
