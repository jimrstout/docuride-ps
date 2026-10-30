// The F&I check against DX1 (2026-10-30): the CRM record's eight product slots
// against the deal's live contracts, for the Generate gate. Mock data only:
// every product name, number and price here is invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COULD_NOT_CHECK,
  DESC_CHECK,
  DESC_MATCH,
  DX1_FIELDS,
  FAILED,
  NOTHING,
  compareToDx1,
  descScore,
  descWords,
  expectedSlot,
  pair,
  readSlots,
  sameResult,
  termMonths,
} from "../supabase/functions/_shared/dx1-check.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const contract = (over) => ({
  contract_number: "SAMPLE-1", category: "Tire and Wheel", product_name: "SAMPLE T&W OFF-ROAD - SAMPLE TIRE & WHEEL",
  plan: "SAMPLE T&W OFF-ROAD", term_months: 36, cents: 59500, provider_name: "Sample Provider", ...over,
});
const TW = contract({});
const CARE = contract({
  contract_number: "SAMPLE-2", category: "Mechanical Protection", product_name: "USED ATV/UTV CARE - SAMPLE CARE COVERAGE",
  plan: "USED ATV/UTV CARE", term_months: 48, cents: 189900,
});
const BATT = contract({
  contract_number: "SAMPLE-3", category: "Battery", product_name: "SAMPLE BATTERY STANDARD USED - SAMPLE BATTERY",
  plan: "SAMPLE BATTERY STANDARD USED", term_months: 24, cents: 14500,
});
const record = (slots) => {
  const r = {};
  for (const [key, dsp, desc, term] of slots) {
    r[`Sold_1_${key}_DSP`] = dsp;
    r[`Sold_1_${key}_Desc`] = desc;
    r[`Sold_1_${key}_Term`] = term;
  }
  return r;
};

test("every slot field the check reads, by its exact CRM name", () => {
  assert.equal(DX1_FIELDS.length, 24);
  for (const k of ["Warranty", "GAP", "PPM", "Aftermarket_1", "Aftermarket_5"]) {
    for (const f of ["DSP", "Desc", "Term"]) assert.ok(DX1_FIELDS.includes(`Sold_1_${k}_${f}`), `${k} ${f}`);
  }
  assert.ok(!DX1_FIELDS.includes("Sold_1_Contract_Tax"));
  // A slot with 0.00 or nothing is no product.
  assert.deepEqual(readSlots(record([["Warranty", 0, "X", "12 Months"], ["GAP", null, null, null], ["PPM", 199.0, "PPM", "24 Months"]])).map((s) => s.key), ["PPM"]);
});

test("terms read as months", () => {
  for (const [t, n] of [["24", 24], ["24 months", 24], ["24 Months", 24], ["24 MONTHS", 24], ["24 Mo", 24], ["24M", 24], ["2 years", 24], ["2 yr", 24], ["1 Month", 1]]) {
    assert.equal(termMonths(t), n, t);
  }
  for (const t of ["N/A", "", null, "twenty four", "0 Months", "1.5 months"]) assert.equal(termMonths(t), null, String(t));
});

test("descriptions: DMS shorthand reads as the same product", () => {
  assert.deepEqual(descWords("T&W OFFRD"), ["tire", "wheel", "offroad"]);
  const cases = [
    ["T&W OFFRD", TW, 1],
    ["TIRE & WHEEL", TW, 1],
    ["T/W", TW, 1],
    ["EXT WARRANTY", CARE, 1],
    ["MECH PROTECTION", CARE, 1],
    ["SVC CONTRACT", CARE, 1],
    ["Care Coverage", CARE, 1],
    ["BATTERY PLAN", BATT, 1],
    ["BATT REPL", BATT, 1],
  ];
  for (const [dx1, c, want] of cases) assert.equal(descScore(dx1, c), want, `${dx1} for ${c.product_name}`);
  // Partly alike: "check the wording".
  const silver = descScore("SILVER CARE", CARE);
  assert.ok(silver >= DESC_CHECK && silver < DESC_MATCH, `SILVER CARE scored ${silver}`);
  // Not the same product at all.
  assert.ok(descScore("TIRE & WHEEL", BATT) < DESC_CHECK);
  // Nothing to compare: no score.
  assert.equal(descScore("THE PLAN", TW), null);
  assert.equal(descScore(null, TW), null);
});

test("expected slots: Mechanical Protection to Warranty, GAP to GAP, Maintenance to PPM, the rest Aftermarket", () => {
  assert.equal(expectedSlot(CARE), "Warranty");
  assert.equal(expectedSlot(contract({ category: "Other", product_name: "SAMPLE GAP WAIVER" })), "GAP");
  assert.equal(expectedSlot(contract({ category: "Maintenance" })), "PPM");
  assert.equal(expectedSlot(TW), "Aftermarket");
});

test("Match: everything agrees, both lists empty", () => {
  const r = compareToDx1([TW, CARE, BATT], [], record([
    ["Warranty", 1899.0, "EXT WARRANTY", "48 Months"],
    ["Aftermarket_1", 595.0, "T&W OFFRD", "36 Months"],
    ["Aftermarket_2", 145.0, "BATTERY", "24 Months"],
  ]));
  assert.deepEqual(r, { status: "Match", blocking: [], warnings: [] });
});

test("a product in an unexpected slot is fine when it otherwise matches", () => {
  const r = compareToDx1([BATT], [], record([["PPM", 145.0, "BATTERY", "24 Months"]]));
  assert.deepEqual(r, { status: "Match", blocking: [], warnings: [] });
});

test("price and term differences block; the description only warns", () => {
  const r = compareToDx1([TW, CARE], [], record([
    ["Warranty", 1899.0, "SILVER CARE", "4 years"],
    ["Aftermarket_1", 585.0, "T&W OFFRD", "N/A"],
  ]));
  assert.equal(r.status, "Problems");
  assert.deepEqual(r.blocking, [
    "Tire and Wheel contract SAMPLE-1: DX1 shows $585.00, the contract is $595.00.",
    'Tire and Wheel contract SAMPLE-1: the term in DX1, "N/A", cannot be read as months. The contract is 36 months.',
  ]);
  assert.deepEqual(r.warnings, [
    'Mechanical Protection contract SAMPLE-2: check the wording. DX1 says "SILVER CARE", the contract is "USED ATV/UTV CARE - SAMPLE CARE COVERAGE".',
  ]);
  // A penny is a difference.
  const penny = compareToDx1([TW], [], record([["Aftermarket_1", 595.01, "T&W OFFRD", "36 Months"]]));
  assert.equal(penny.blocking.length, 1);
});

test("a contract not keyed, and a slot with no contract (voided, said so)", () => {
  const voidedBatt = { ...BATT, contract_number: "SAMPLE-9" };
  const r = compareToDx1([TW, BATT], [voidedBatt], record([
    ["Aftermarket_1", 595.0, "T&W OFFRD", "36 Months"],
    ["Aftermarket_2", 199.0, "THEFT PROT", "36 Months"],
  ]));
  assert.deepEqual(r.blocking, [
    "Battery contract SAMPLE-3 is not keyed in DX1.",
    "Aftermarket 2 shows $199.00 in DX1 but there is no live contract for it.",
  ]);
  const v = compareToDx1([TW], [voidedBatt], record([
    ["Aftermarket_1", 595.0, "T&W OFFRD", "36 Months"],
    ["Aftermarket_2", 145.0, "BATTERY", "24 Months"],
  ]));
  assert.deepEqual(v.blocking, [
    "Aftermarket 2 shows $145.00 in DX1 but there is no live contract for it. It matches Battery contract SAMPLE-9, which was voided.",
  ]);
});

test("a description so different it is not the same product is still only a warning", () => {
  const r = compareToDx1([BATT], [], record([["Aftermarket_1", 145.0, "TIRE & WHEEL", "24 Months"]]));
  assert.deepEqual(r.blocking, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /does not look like this product/);
});

test("pairing takes the best pairs first; two of a kind sort out by price", () => {
  const TW2 = contract({ contract_number: "SAMPLE-4", cents: 79500 });
  const p = pair([TW, TW2], readSlots(record([
    ["Aftermarket_1", 795.0, "T&W", "36 Months"],
    ["Aftermarket_2", 595.0, "T&W", "36 Months"],
  ])));
  assert.deepEqual(p.pairs.map(([c, s]) => [c.contract_number, s.key]), [["SAMPLE-1", "Aftermarket_2"], ["SAMPLE-4", "Aftermarket_1"]]);
});

test("Nothing to check, and could not check: the exact responses", () => {
  assert.deepEqual(NOTHING, { status: "Nothing to check", blocking: [], warnings: [] });
  assert.deepEqual(compareToDx1([], [], record([["Warranty", 100, "X", "12"]])), NOTHING);
  assert.deepEqual(FAILED, { status: "Nothing to check", blocking: [], warnings: ["F&I contracts could not be checked against DX1"] });
  assert.equal(COULD_NOT_CHECK, "F&I contracts could not be checked against DX1");
  assert.ok(sameResult({ status: "Match", blocking: [], warnings: [] }, { status: "Match", blocking: [], warnings: [] }));
  assert.ok(!sameResult(null, NOTHING));
});

test("the endpoint: secret, always 200 JSON, a budget, the session kept, an event only on change, no CRM write", () => {
  const fn = read("supabase/functions/fni-dx1-check/index.ts");
  assert.match(fn, /if \(!secretsMatch\(presented, configured\)\) \{[\s\S]*?return reply\(401,/);
  assert.match(fn, /const BUDGET_MS = 4500;/);
  assert.match(fn, /await Promise\.race\(\[check\(body\), late\]\)/);
  assert.match(fn, /return reply\(200, \{ status: result\.status, blocking: result\.blocking, warnings: result\.warnings \}\);/);
  assert.match(fn, /\} catch \(err\) \{[\s\S]*?return reply\(200, FAILED\);/);
  assert.match(fn, /if \(sameResult\(previous, result\)\) return;/);
  assert.match(fn, /created_by: "System"/);
  // Reads the CRM, never writes it.
  assert.match(fn, /await getRecord\(MODULE, s\.zoho_deal_id\)/);
  assert.doesNotMatch(fn, /updateRecord|upsertRecord|PUT|PATCH|method: "POST"/);
  // Logs: ids, counts and the status only.
  assert.doesNotMatch(fn, /console\.\w+\([^;]*(record\b|desc|price|cents|product_name|blocking:\s*result\.blocking\s*[,}])/);
  assert.match(read("supabase/config.toml"), /\[functions\.fni-dx1-check\]\nverify_jwt = false/);
  // Not run from zoho-sync.
  assert.doesNotMatch(read("supabase/functions/zoho-sync/index.ts"), /dx1-check/);
});

test("every line is plain English, with no em dash", () => {
  const r = compareToDx1([TW, CARE, BATT], [{ ...BATT, contract_number: "SAMPLE-9" }], record([
    ["Warranty", 1.0, null, null],
    ["Aftermarket_1", 1.0, "LASERS", "2 years"],
    ["Aftermarket_4", 145.0, "BATTERY", "24"],
  ]));
  for (const l of [...r.blocking, ...r.warnings]) assert.doesNotMatch(l, /—|undefined|null|NaN/);
});

test("Details shows the latest check, refreshed on load, for signed-in staff only", () => {
  const page = read("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(page, /const dx1Promise: Promise<Dx1CheckResult \| null> = operator\s*\? edge\.dx1Check<Dx1CheckResult>\(sessionId\)\.catch\(/);
  assert.match(page, /: Promise\.resolve\(null\);/);
  assert.match(page, /<h2 id="vcontracts-title">Contracts<\/h2>\s*<Dx1Check result=\{dx1\} \/>/);
  const edge = read("apps/ownership-planner/lib/edge.ts");
  assert.match(edge, /call<T>\("fni-dx1-check", \{ method: "POST", body: \{ session_id: sessionId \} \}\)/);
  const view = read("apps/ownership-planner/components/Dx1Check.tsx");
  assert.match(view, /if \(result\.status === "Nothing to check" && result\.warnings\.length === 0\) return null;/);
  assert.match(view, /fix these before generating documents/);
  assert.doesNotMatch(view, /—/);
  // The endpoint takes Details' session id as well as the gate's record id.
  assert.match(read("supabase/functions/fni-dx1-check/index.ts"), /q = UUID\.test\(sessionId\) \? q\.eq\("id", sessionId\) : q\.eq\("zoho_deal_id", zohoId\);/);
});
