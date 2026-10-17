// Multi-provider Part 5: price sheet upload and parsing.
//
// The checks flag and never drop; publishing is refused while anything is
// flagged; the schema Claude answers in is closed and complete; the key is read
// from one secret name only and never shown; nothing deletes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  checkRates,
  datesOverlap,
  inForceOn,
  publishRefusal,
  rowProblems,
} from "../supabase/functions/_shared/price-sheet-checks.ts";
import { RATES_SCHEMA, csvChunks, systemPrompt, toDraftRates } from "../supabase/functions/_shared/price-sheet-extract.ts";
import { fileTypeFor, parseRateEdit, parseUpload, safeFileName } from "../supabase/functions/_shared/price-sheet-admin.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const rate = (over = {}) => ({
  product_code: "BEST-3", product_name: "BRP Extended Service Terms", makes: ["Can-Am"],
  model_contains: [], year_min: null, year_max: null, vehicle_types: ["UTV"], conditions: ["New"],
  engine_cc_min: null, engine_cc_max: null, term_months: 36, term_miles: null, deductible: 50,
  dealer_cost: 410, suggested_retail: 699, confidence: "High", model_note: null,
  flagged: false, flag_reason: null, ...over,
});

// ── The checks ───────────────────────────────────────────────────────────

test("a clean rate has no problems", () => {
  assert.deepEqual(rowProblems(rate()), []);
});

test("each problem is a sentence a reviewer can act on", () => {
  assert.deepEqual(rowProblems(rate({ dealer_cost: null })), ["The dealer cost is missing."]);
  assert.deepEqual(rowProblems(rate({ dealer_cost: 0, suggested_retail: null })), ["The dealer cost of $0.00 is not more than zero."]);
  assert.match(rowProblems(rate({ term_months: 240 })).join(), /A term of 240 months is outside 1 to 120\./);
  assert.match(rowProblems(rate({ deductible: 9000 })).join(), /A deductible of \$9000\.00 is outside \$0 to \$5,000\./);
  assert.match(rowProblems(rate({ suggested_retail: 300 })).join(), /suggested retail of \$300\.00 is below the dealer cost/);
  assert.match(rowProblems(rate({ vehicle_types: ["HOVERCRAFT"] })).join(), /matches no vehicle type we rate: HOVERCRAFT/);
  assert.match(rowProblems(rate({ year_min: 2026, year_max: 2020 })).join(), /model years run backwards/);
  assert.match(rowProblems(rate({ makes: [] })).join(), /names no make/);
  assert.match(rowProblems(rate({ confidence: "Low", model_note: "column blurred" })).join(), /not sure: column blurred/);
});

test("the checks flag, never drop, and catch duplicates", () => {
  const rows = [rate(), rate(), rate({ dealer_cost: null })];
  const out = checkRates(rows);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.flagged), [false, true, true]);
  assert.match(out[1].flag_reason, /It repeats row 1: same product, term, deductible and eligibility\./);
});

test("publishing is refused while anything not left out is flagged", () => {
  const sheet = { id: "s", name: "BRP 2026", status: "Draft", parse_status: "Parsed", effective_from: "2026-01-01", effective_to: null };
  assert.equal(publishRefusal(sheet, [{ flagged: false }]), null);
  assert.equal(
    publishRefusal(sheet, [{ flagged: true }, { flagged: false }]),
    `"BRP 2026" has 1 flagged rate. Correct it, or leave it out, before publishing.`
  );
  assert.equal(publishRefusal(sheet, [{ flagged: true, left_out: true }, { flagged: false }]), null);
  assert.match(publishRefusal({ ...sheet, parse_status: "Not Parsed" }, []), /has not been read yet/);
  assert.match(publishRefusal({ ...sheet, status: "Published" }, []), /already published/);
  assert.match(publishRefusal(sheet, [{ flagged: false, left_out: true }]), /has no rates to publish/);
});

test("one sheet in force per day: overlaps and dates", () => {
  assert.ok(datesOverlap({ effective_from: "2026-01-01", effective_to: null }, { effective_from: "2026-06-01", effective_to: "2026-12-31" }));
  assert.ok(!datesOverlap({ effective_from: "2026-01-01", effective_to: "2026-05-31" }, { effective_from: "2026-06-01", effective_to: null }));
  const s = { status: "Published", effective_from: "2026-01-01", effective_to: "2026-12-31" };
  assert.ok(inForceOn(s, "2026-10-16"));
  assert.ok(!inForceOn(s, "2027-01-01"));
  assert.ok(!inForceOn({ ...s, status: "Draft" }, "2026-10-16"));
});

// ── What Claude is asked ─────────────────────────────────────────────────

test("the schema is closed and complete everywhere, with no unsupported constraints", () => {
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, `${path} must be closed`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${path} must require every field`);
    }
    for (const bad of ["minimum", "maximum", "minLength", "maxLength", "multipleOf", "minItems", "maxItems"]) {
      assert.ok(!(bad in node), `${path} uses ${bad}`);
    }
    for (const [k, v] of Object.entries(node)) if (typeof v === "object") walk(v, `${path}.${k}`);
  };
  walk(RATES_SCHEMA, "root");
});

test("the instructions say never to guess, and name the provider", () => {
  const p = systemPrompt("BRP", ["Can-Am", "Sea-Doo"]);
  assert.match(p, /This sheet is from BRP, whose program covers Can-Am, Sea-Doo\./);
  assert.match(p, /Never guess/);
  assert.doesNotMatch(p, /\u2014/);
});

test("CSV goes in chunks with the header on each, so nothing is cut", () => {
  const csv = ["Product,Term,Cost", ...Array.from({ length: 600 }, (_, i) => `P${i},36,${100 + i}`)].join("\n");
  const chunks = csvChunks(csv, "Rates", 250);
  assert.deepEqual(chunks.map((c) => c.label), [
    "tab Rates, rows 1 to 250", "tab Rates, rows 251 to 500", "tab Rates, rows 501 to 600",
  ]);
  for (const c of chunks) assert.ok(c.data.startsWith("Product,Term,Cost\n"));
  assert.equal(chunks.reduce((n, c) => n + c.data.split("\n").length - 1, 0), 600);
});

test("the answer becomes rows: cents, whole numbers, the provider's makes by default", () => {
  const [row] = toDraftRates("sheet-1", [{
    product_code: " BEST-3 ", product_name: "BEST", family_code: "BEST", plan: "3 years", category: "Mechanical Protection",
    makes: [], model_contains: [" Defender "], year_min: 2024, year_max: null, vehicle_types: ["utv"], conditions: ["New"],
    max_age_years: null, max_odometer: null, engine_cc_min: null, engine_cc_max: null, max_months_in_service: null,
    term_months: 36, term_miles: null, deductible: 50, dealer_cost: 410.004, suggested_retail: 699.999,
    options: [{ code: "COM", label: "Commercial use", cost_delta: 75, mandatory: false }],
    source_ref: "", confidence: "Unsure", note: " ",
  }], ["Can-Am", "Sea-Doo"], "pages 1 to 10");
  assert.equal(row.product_code, "BEST-3");
  assert.deepEqual(row.makes, ["Can-Am", "Sea-Doo"]);
  assert.deepEqual(row.model_contains, ["Defender"]);
  assert.deepEqual(row.vehicle_types, ["UTV"]);
  assert.equal(row.dealer_cost, 410);
  assert.equal(row.suggested_retail, 700);
  assert.equal(row.source_ref, "pages 1 to 10");
  assert.equal(row.confidence, "Low");
  assert.equal(row.model_note, null);
  assert.deepEqual(row.options[0], { code: "COM", label: "Commercial use", cost_delta: 75, mandatory: false, applied: false });
});

// ── What staff send ──────────────────────────────────────────────────────

test("an upload is checked field by field", () => {
  const ok = parseUpload({
    provider_id: "11111111-1111-4111-8111-111111111111", name: "BRP 2026", effective_from: "2026-01-01",
    effective_to: "", file_name: "BRP rates 2026.PDF", file_base64: Buffer.from("%PDF-1.4").toString("base64"),
    uploaded_by: "Jim",
  });
  assert.ok("fields" in ok);
  assert.equal(ok.fields.file_type, "PDF");
  assert.equal(ok.fields.effective_to, null);

  const bad = parseUpload({ provider_id: "x", name: "", effective_from: "soon", file_name: "rates.docx", file_base64: "", uploaded_by: "" });
  assert.deepEqual(bad.errors, [
    "Choose the provider this sheet is from.",
    "Give the sheet a name, such as \"BRP 2026 rates\".",
    "Give the date the sheet takes effect.",
    "Who is uploading the sheet is missing.",
    "The file must be a PDF, an Excel workbook (XLSX or XLS) or a CSV.",
    "The file is empty or did not arrive.",
  ]);
  assert.equal(fileTypeFor("a.xls").type, "XLS");
  assert.equal(safeFileName("BRP rates (2026) final!.pdf"), "BRP-rates-2026-final.pdf");
});

test("a correction is checked and typed the way a person types it", () => {
  const r = parseRateEdit({ dealer_cost: "$1,250.50", term_months: "36", vehicle_types: "utv, atv", conditions: "new", makes: "Can-Am, Can-Am" });
  assert.deepEqual(r.patch, { term_months: 36, dealer_cost: 1250.5, makes: ["Can-Am"], vehicle_types: ["UTV", "ATV"], conditions: ["New"] });
  assert.deepEqual(parseRateEdit({ dealer_cost: "lots" }).errors, ["Dealer cost must be an amount in dollars and cents."]);
  assert.deepEqual(parseRateEdit({ product_name: "" }).errors, ["Product name cannot be blank."]);
  assert.deepEqual(parseRateEdit({}).errors, ["Nothing was changed."]);
});

// ── The secret, and nothing deleted ──────────────────────────────────────

test("the key is read from one secret name, never another, and never shown", () => {
  const reader = src("../supabase/functions/_shared/anthropic-price-sheet.ts");
  const parseFn = src("../supabase/functions/fni-price-sheet-parse/index.ts");
  assert.match(reader, /export const KEY_SECRET = "DOCURIDE_PS_ANTHROPIC_API_KEY";/);
  assert.match(reader, /export const MODEL_SECRET = "DOCURIDE_PS_ANTHROPIC_MODEL";/);
  assert.match(reader, /export const DEFAULT_MODEL = "claude-sonnet-5-5";/);
  // Only those two names are read, in the reader.
  assert.deepEqual([...reader.matchAll(/Deno\.env\.get\(([^)]+)\)/g)].map((m) => m[1]), ["KEY_SECRET", "MODEL_SECRET"]);
  // No other ANTHROPIC name anywhere in the functions.
  const dir = new URL("../supabase/functions/", import.meta.url);
  for (const f of readdirSync(dir, { recursive: true }).filter((p) => String(p).endsWith(".ts"))) {
    const body = readFileSync(new URL(String(f), dir), "utf8");
    for (const m of body.matchAll(/["'`]([A-Z_]*ANTHROPIC[A-Z_]*)["'`]/g)) {
      assert.ok(["DOCURIDE_PS_ANTHROPIC_API_KEY", "DOCURIDE_PS_ANTHROPIC_MODEL"].includes(m[1]), `${f} names ${m[1]}`);
    }
  }
  // The key is never logged or returned.
  for (const body of [reader, parseFn, src("../supabase/functions/_shared/price-sheet-parse.ts")]) {
    assert.doesNotMatch(body, /console\.[a-z]+\([^)]*\bkey\b/);
    assert.doesNotMatch(body, /json\([^)]*\bkey\b/);
  }
  assert.match(reader, /The \$\{KEY_SECRET\} secret is not set, so price sheets cannot be read\./);
  assert.match(parseFn, /return json\(400, \{ error: MISSING_KEY_MESSAGE \}\);/);
});

test("a parse is always a Draft, structured, and refusals are handled", () => {
  const reader = src("../supabase/functions/_shared/anthropic-price-sheet.ts");
  assert.match(reader, /output_config: \{ format: \{ type: "json_schema" as const, schema: RATES_SCHEMA \} \}/);
  assert.doesNotMatch(reader, /tool_choice/);
  assert.match(reader, /m\.stop_reason === "refusal"/);
  const parse = src("../supabase/functions/_shared/price-sheet-parse.ts");
  assert.doesNotMatch(parse, /status: "Published"/);
  assert.match(parse, /parse_status: "Parsed"/);
});

test("nothing deletes: rates are left out, sheets retired", () => {
  for (const f of [
    "../supabase/functions/fni-price-sheets/index.ts",
    "../supabase/functions/fni-price-sheet-parse/index.ts",
    "../supabase/functions/_shared/price-sheet-parse.ts",
  ]) {
    assert.doesNotMatch(src(f), /\.delete\(|\.remove\(/, f);
  }
  const sql = src("../supabase/migrations/0025_price_sheets.sql");
  assert.doesNotMatch(sql, /\bdrop\b/i);
  assert.match(sql, /'price-sheets', 'price-sheets', false,/);
  assert.match(sql, /left_out\s+boolean not null default false/);
});
