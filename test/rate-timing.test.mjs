// Rate timing: how long each step of a rating takes, kept in the "Rated again"
// event under "timing" (_shared/rate-timing.ts). Measuring only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RateTiming, rateLineCount, responseBytes } from "../supabase/functions/_shared/rate-timing.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("marks are milliseconds since the request, and the slowest step is named", () => {
  let t = 1000;
  const timing = new RateTiming(() => t);
  timing.mark("request received");
  t = 1250; timing.mark("session loaded");
  t = 6250; timing.mark("rate response received");
  t = 6400; timing.mark("offer stored");
  timing.note("provider_login", "cached");
  timing.note("rate_lines", 465);
  const d = timing.detail();
  assert.deepEqual(d.steps.map((s) => [s.step, s.ms]), [["request received", 0], ["session loaded", 250], ["rate response received", 5250], ["offer stored", 5400]]);
  assert.deepEqual(d.slowest, { step: "rate response received", ms: 5000 });
  assert.equal(d.total_ms, 5400);
  // The facts sit under their own key (#146 spread them at the top level,
  // so detail.timing.facts read as null).
  assert.deepEqual(d.facts, { provider_login: "cached", rate_lines: 465 });
  assert.deepEqual(Object.keys(d).sort(), ["facts", "slowest", "steps", "total_ms"]);
});

test("rate lines are counted across every product, with or without the quote envelope", () => {
  const quote = { quote: { vehicles: [{ products: [{ rates: [1, 2, 3] }, { rates: [1] }, { rates: [] }, {}] }] } };
  assert.equal(rateLineCount(quote), 4);
  assert.equal(rateLineCount(quote.quote), 4);
  assert.equal(rateLineCount(null), 0);
  assert.equal(responseBytes({ a: "é" }), new TextEncoder().encode('{"a":"é"}').length);
});

test("the Rated again event carries the timing, and the rate path marks each step", () => {
  const fn = read("supabase/functions/fni-rate-vehicle/index.ts");
  assert.match(fn, /detail: \{ \.\.\.detail, timing: timing\.detail\(\) \}/);
  for (const step of ["request received", "staff sign-in checked", "session loaded", "sale date read", "contracts read",
    "selections read", "earlier offer read", "session updated", "selection comparison done", "reply ready"]) {
    assert.ok(fn.includes(`timing.mark("${step}")`), step);
  }
  const session = read("supabase/functions/_shared/rate-session.ts");
  for (const step of ["menu and providers read", "provider account read", "every provider answered", "offer stored and program names kept"]) {
    assert.ok(session.includes(`timing?.mark("${step}")`), step);
  }
  const adapter = read("supabase/functions/_shared/adapters/tecassured.ts");
  for (const step of ["rate properties ready", "brand and makes list ready", "provider login ready", "rate request sent", "rate response received"]) {
    assert.ok(adapter.includes(`mark("${step}")`), step);
  }
  assert.match(adapter, /timing\.note\("provider_login", auth\.fromCache \? "cached" : "fresh"\)/);
  assert.match(adapter, /timing\.note\("response_bytes", responseBytes\(response\)\)/);
  assert.match(adapter, /timing\.note\("rate_lines", rateLineCount\(response\)\)/);
});

test("timing never carries a secret: only step names, numbers and short words", () => {
  const src = read("supabase/functions/_shared/rate-timing.ts");
  assert.doesNotMatch(src, /password|sessionId|token|buyer/i.test("") ? /$^/ : /\.(password|sessionId|token)\b/);
  const adapter = read("supabase/functions/_shared/adapters/tecassured.ts");
  const notes = [...adapter.matchAll(/timing\.note\("([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(notes)].sort(), [
    "provider_login", "provider_login_retried", "rate_lines", "response_bytes", "saved_login_age_s", "saved_login_from", "saved_login_used",
  ]);
});

// ── Speed, part 1: the reads that do not depend on each other go together ──
test("Rate again reads in parallel what does not depend on what came before", () => {
  const fn = read("supabase/functions/fni-rate-vehicle/index.ts");
  // The provider, the contracts, the selections and the earlier offer are
  // started before the CRM read and awaited after it.
  const crm = fn.indexOf("const crmRead = useStored ? null : await freshSaleDate(");
  for (const started of ["const providerRead = tecAssuredProviderId(", "const contractsRead = purchasedFor(", "const before = body.rate_again === true ? rateAgainReads("]) {
    const at = fn.indexOf(started);
    assert.ok(at > 0 && at < crm, started);
  }
  assert.ok(fn.indexOf("await Promise.all([providerRead, contractsRead])") > crm);
  // The quote the selections were made from is still read before it is replaced.
  const again = fn.slice(fn.indexOf("async function rateAgain("));
  assert.ok(again.indexOf("await reads.beforeRows") < again.indexOf("await rateSession("));
  // After the rate: the session update, the pricing rules and the fresh offer together.
  assert.match(again, /await Promise\.all\(\[\s*sessionUpdate,[\s\S]*?from\("pricing_rules"\)[\s\S]*?offerRowsFor\(supabase, sess\.id\),\s*\]\)/);

  const session = read("supabase/functions/_shared/rate-session.ts");
  // The store's account is read while the menu is, and used only if TecAssured is rated.
  assert.ok(session.indexOf("const tecStore = createTecAssuredClient(") < session.indexOf("await menuFor("));
  assert.match(session, /store = await \(tecStore \?\? createTecAssuredClient\(storeId, supabase\)\);/);

  const adapter = read("supabase/functions/_shared/adapters/tecassured.ts");
  // The brand's inputs are read while the rate properties are; the make is
  // still settled after the properties, and the makes list fetched from the
  // provider only once a brand is settled.
  const rate = adapter.slice(adapter.indexOf("async rate()"));
  assert.ok(rate.indexOf("const brandRead = brandReads(rateSource);") < rate.indexOf("props = await required();"));
  assert.ok(rate.indexOf("props = await required();") < rate.indexOf("await providerMake(rateSource, await brandRead)"));
  const make = adapter.slice(adapter.indexOf("async function providerMake("), adapter.indexOf("async function readMakes("));
  assert.ok(make.indexOf('if (m.status !== "brand") return { refusal: m.message };') < make.indexOf("await makesList("));
});
