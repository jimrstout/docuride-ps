// The provider's raw answer is kept when a submit does not simply succeed
// (2026-10-28). Deal 15029's submit at 17:29 UTC on 28 Oct ended in Submit
// Status Unknown with only a one-line summary saved; the response, its HTTP
// status and any request ID were lost. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  PROVIDER_ANSWER_EVENT,
  personalValues,
  providerAnswer,
  providerAnswerText,
  REDACTED,
  REMOVED,
} from "../supabase/functions/_shared/provider-answer.ts";

const here = (rel) => new URL(rel, import.meta.url);
const read = (rel) => readFileSync(here(`../${rel}`), "utf8");

/**
 * The real _shared/tecassured.ts, with its one remote import (supabase-js
 * from esm.sh, which Node cannot load) swapped for a stub.
 */
async function loadClient() {
  const src = read("supabase/functions/_shared/tecassured.ts")
    .replace('import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";', "const createClient = () => { throw new Error('not in tests'); };")
    .replace('from "./provider-rows.ts"', `from ${JSON.stringify(here("../supabase/functions/_shared/provider-rows.ts").href)}`);
  // Compiled rather than stripped: the file uses constructor parameter properties.
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const file = join(mkdtempSync(join(tmpdir(), "tecassured-")), "tecassured.mjs");
  writeFileSync(file, js);
  return await import(pathToFileURL(file).href);
}

/** A client with a valid cached session, so no login is made. */
function client(mod) {
  const writes = [];
  const supabase = { schema: () => ({ from: () => ({ update: (p) => ({ eq: () => { writes.push(p); return Promise.resolve({}); } }) }) }) };
  const c = new mod.TecAssuredClient(
    {
      id: "cred-1", api_base_url: "https://qa.example.test/rs", username: "mock-user", password_encrypted: "mock-pass",
      session_id_cached: "mock-session", session_expires_at: new Date(Date.now() + 600_000).toISOString(), updated_at: "t",
    },
    supabase,
    "0-000"
  );
  return { c, writes };
}

function withFetch(answer, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => answer();
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}

const HEADERS = { "content-type": "application/json", "x-request-id": "REQ-MOCK-1", "set-cookie": "s=secret", "authorization": "Bearer mock" };

test("the client keeps the HTTP status and request ID beside the body; a success reads exactly as before", async () => {
  const mod = await loadClient();
  const body = { contracts: [{ contractNumber: "MOCK-1", rateUniqueId: "1", productId: 1, pdfLink: "x" }] };
  await withFetch(() => new Response(JSON.stringify(body), { status: 200, headers: HEADERS }), async () => {
    const { c } = client(mod);
    const got = await c.submitContractDetailed({ quote: {} });
    assert.equal(got.status, 200);
    assert.deepEqual(got.request_ids, { "x-request-id": "REQ-MOCK-1" });
    assert.deepEqual(got.body, body);
    // No other header is kept: never a cookie or an authorization.
    assert.doesNotMatch(JSON.stringify(got.request_ids), /secret|Bearer/);
    // The plain call returns the same body it always did.
    assert.deepEqual(await c.submitContract({ quote: {} }), body);
  });
});

test("a failure the provider answers carries its status, request ID and text", async () => {
  const mod = await loadClient();
  await withFetch(() => new Response("Gateway exploded", { status: 502, headers: HEADERS }), async () => {
    const { c } = client(mod);
    await assert.rejects(c.submitContractDetailed({}), (err) => {
      assert.ok(err instanceof mod.ProviderHttpError);
      assert.equal(err.exchange.status, 502);
      assert.deepEqual(err.exchange.request_ids, { "x-request-id": "REQ-MOCK-1" });
      assert.equal(err.exchange.raw, "Gateway exploded");
      assert.match(err.message, /^TecAssured API call failed \(502, x-request-id REQ-MOCK-1\): Gateway exploded$/);
      return true;
    });
  });
  // A body that is not JSON is kept as text too.
  await withFetch(() => new Response("<html>oops</html>", { status: 200, headers: HEADERS }), async () => {
    const { c } = client(mod);
    await assert.rejects(c.submitContractDetailed({}), (err) => err instanceof mod.ProviderHttpError && err.exchange.raw === "<html>oops</html>");
  });
});

test("an unknown outcome keeps the status, request ID and body", () => {
  const a = providerAnswer({
    kind: "Submit outcome unknown",
    http_status: 200,
    request_ids: { "x-request-id": "REQ-MOCK-1" },
    body: { contracts: [{ rateUniqueId: "34347", productId: 1 }] },
    note: "Sample Provider created 0 of 1 contract.",
  });
  assert.deepEqual(a, {
    kind: "Submit outcome unknown",
    http_status: 200,
    request_ids: { "x-request-id": "REQ-MOCK-1" },
    body: { contracts: [{ rateUniqueId: "34347", productId: 1 }] },
    note: "Sample Provider created 0 of 1 contract.",
    truncated: false,
  });
  const text = providerAnswerText(a);
  assert.match(text, /^Submit outcome unknown\nHTTP status: 200\nRequest ID: REQ-MOCK-1 \(x-request-id\)\n/);
  assert.match(text, /"rateUniqueId": "34347"/);
  // No answer at all (a dropped connection) says so.
  assert.match(providerAnswerText(providerAnswer({ kind: "Submit outcome unknown", http_status: null, body: null })), /HTTP status: no answer\nRequest ID: none sent/);

  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /const exchange = await client\.submitContractDetailed\(submitPayload\);\s*lastAnswer = \{ status: exchange\.status, request_ids: exchange\.request_ids, body: exchange\.body \};/);
  // Every unknown path goes through markUnknown, which keeps the answer.
  assert.match(submit, /\.eq\("submit_token", lockToken\);\s*\/\/[^\n]*\n\s*await keepAnswer\("Submit outcome unknown", detail\);/);
  // A refusal, a partial refusal, and a failure the provider answered are kept too.
  assert.match(submit, /if \(reading\.refusedOutright\) \{\s*await keepAnswer\("Submit refused", reading\.message\);/);
  assert.match(submit, /await keepAnswer\("Submit partly refused", reading\.message\);/);
  assert.match(submit, /if \(providerWasCalled && err instanceof ProviderHttpError\) \{\s*lastAnswer = \{ status: err\.exchange\.status, request_ids: err\.exchange\.request_ids, body: err\.exchange\.raw \};/);
  assert.match(submit, /event: PROVIDER_ANSWER_EVENT, detail: answer, created_by: "fni-contract-submit"/);
  assert.equal(PROVIDER_ANSWER_EVENT, "Provider's answer kept");
  // Once per submit, and only when the provider was called.
  assert.match(submit, /if \(answerKept \|\| !providerWasCalled\) return;/);
});

test("personal details are taken out, by key and by the session's own values", () => {
  const session = {
    buyer_first_name: "Sample", buyer_last_name: "Buyer", buyer_display_name: "Sample Buyer", buyer_email: "buyer@example.test",
    buyer_phone: "555-123-4567", buyer_address: "1 Mock Street", buyer_state: "WV", buyer_type: "Individual",
    cobuyer_first_name: "Other", lienholder_name: "Mock Bank", vin: "TESTVIN",
  };
  const known = personalValues(session);
  assert.ok(known.includes("Sample Buyer") && known.includes("Mock Bank"));
  assert.ok(!known.includes("WV") && !known.includes("Individual") && !known.includes("TESTVIN"));
  const a = providerAnswer({
    kind: "Submit refused",
    http_status: 200,
    body: {
      error: "Contract for Sample Buyer at 1 Mock Street refused; call 555-123-4567 or write buyer@example.test",
      quote: { buyerFirstName: "Sample", buyerLastName: "Buyer", buyerAddress: "1 Mock Street", buyerPostalCode: "26000", lienholder: { lienholderName: "Mock Bank" } },
      contracts: [{ productName: "RA BATTERY STANDARD USED - RIDERS ADVANTAGE BATTERY", rateUniqueId: "34347", cancellationFee: 50, dealerName: "Mock Dealer" }],
    },
    known,
  });
  const json = JSON.stringify(a);
  for (const leak of ["Sample", "Buyer\"", "Mock Street", "555-123-4567", "buyer@example.test", "Mock Bank", "26000"]) {
    assert.ok(!json.includes(leak), leak);
  }
  assert.equal(a.body.quote.buyerFirstName, REDACTED);
  assert.equal(a.body.quote.lienholder.lienholderName, REDACTED);
  assert.match(a.body.error, /^Contract for \[redacted\] at \[redacted\] refused; call \[redacted\] or write \[redacted\]$/);
  // Things, not people, are left as they are.
  assert.equal(a.body.contracts[0].productName, "RA BATTERY STANDARD USED - RIDERS ADVANTAGE BATTERY");
  assert.equal(a.body.contracts[0].cancellationFee, 50);
  assert.equal(a.body.contracts[0].dealerName, "Mock Dealer");
});

test("the probe's made-up values stay", () => {
  const a = providerAnswer({
    kind: "Submit outcome unknown",
    http_status: 200,
    body: { quote: { buyerPhone: "3045550101", phone: "304-555-0114", cobuyerFirstName: "CB03", cobuyerLastName: "CB03", coBuyerName: "CB26 CB26" }, message: "unknown field buyerPhone 3045550120" },
    known: ["Sample Buyer"],
  });
  assert.deepEqual(a.body.quote, { buyerPhone: "3045550101", phone: "304-555-0114", cobuyerFirstName: "CB03", cobuyerLastName: "CB03", coBuyerName: "CB26 CB26" });
  assert.equal(a.body.message, "unknown field buyerPhone 3045550120");
});

test("credentials, tokens and session IDs are never kept", () => {
  const a = providerAnswer({
    kind: "Submit outcome unknown",
    http_status: 200,
    request_ids: { "x-request-id": "REQ-1", authorization: "Bearer mock", "x-session-token": "mock" },
    body: { sessionId: "mock-session", token: "mock-token", data: { password: "mock-pass", username: "mock-user", apiKey: "k" }, ok: true },
  });
  assert.deepEqual(a.request_ids, { "x-request-id": "REQ-1" });
  assert.deepEqual(a.body, { sessionId: REMOVED, token: REMOVED, data: { password: REMOVED, username: REMOVED, apiKey: REMOVED }, ok: true });
  assert.doesNotMatch(JSON.stringify(a), /mock-session|mock-token|mock-pass|mock-user|Bearer/);
  // The submit's own request carries the session ID; the answer kept is the response alone.
  assert.doesNotMatch(read("supabase/functions/fni-contract-submit/index.ts"), /providerAnswer\(\{[^}]*submitPayload/);
});

test("a long answer is cut, and says so", () => {
  const a = providerAnswer({ kind: "Submit outcome unknown", http_status: 200, body: "x".repeat(60_000) });
  assert.equal(a.truncated, true);
  assert.ok(a.body.length <= 50_003);
  assert.match(providerAnswerText(a), /\(cut at 50,000 characters\)$/);
});

test("Details shows it behind Show details, with Copy error", () => {
  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /\.eq\("event", PROVIDER_ANSWER_EVENT\)\s*\.order\("created_at", \{ ascending: false \}\)\s*\.limit\(1\)/);
  assert.match(verify, /provider_answer: providerAnswer,/);
  const c = read("apps/ownership-planner/components/ProviderAnswer.tsx");
  assert.match(c, /<span className="rating-banner-toggle rating-banner-toggle--show">Show details<\/span>/);
  assert.match(c, /<RatingErrorText deal=\{deal\} failures=\{\[\{ provider, text: answer\.text, at: answer\.at \}\]\} \/>/);
  // RatingErrorText is what gives it the scrolling box and Copy error.
  assert.match(read("apps/ownership-planner/components/RatingErrorText.tsx"), /<CopyErrorButton text=\{copyErrorText\(deal, f\)\} \/>/);
  const page = read("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  // In the Submit Status Unknown notice while the outcome is unknown, in the Contracts panel otherwise.
  const unknown = page.slice(page.indexOf("<h2>Submit Status Unknown</h2>"), page.indexOf("{operator ? (\n            <form action={clearSubmitUnknown}>"));
  assert.match(unknown, /\{sheet\.provider_answer \? \(\s*<ProviderAnswer/);
  assert.match(page, /\{sheet\.provider_answer && sheet\.submit_state !== "Submit Status Unknown" \? \(\s*<ProviderAnswer/);
});

test("a rating the provider answers with a failure keeps its status, request ID and body too", () => {
  const ad = read("supabase/functions/_shared/adapters/tecassured.ts");
  assert.match(ad, /\.\.\.\(err instanceof ProviderHttpError\s*\?\s*\{\s*response: providerAnswer\(\{\s*kind: "Rating failed",\s*http_status: err\.exchange\.status,\s*request_ids: err\.exchange\.request_ids,\s*body: err\.exchange\.raw,/);
  // Stored with the attempt, as a Failed result's response always is.
  assert.match(read("supabase/functions/_shared/rate-session.ts"), /return o\.result\.response \?\? null;/);
});
