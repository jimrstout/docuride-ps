// Multi-provider Part 7: the planner across providers, and OEM contracts.
//
// A slot that holds one family shows exactly that family, so "All deals" is
// today's menu. A Side by Side slot that mixes providers becomes one decision
// whose tiers name their provider. Product copy is found by provider and code.
// OEM contracts are recorded by staff: nothing about them is ever sent to
// TecAssured, and a mixed submit holds them back and says so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeOffer } from "../supabase/functions/_shared/planner-offers.ts";
import { resolveSlots, slotFamilies } from "../supabase/functions/_shared/menu-templates.ts";
import { catalogKey, classifyCoverage, indexCatalog } from "../supabase/functions/_shared/planner-catalog.ts";
import {
  contractStateLabel,
  documentPathFor,
  goalFor,
  isRecorded,
  newCatalogRows,
  parseRecord,
  parseVoid,
  splitSelections,
} from "../supabase/functions/_shared/oem-contracts.ts";
import { parseWording, wordingMissing } from "../supabase/functions/_shared/menu-admin.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const QUOTE = JSON.parse(src("./fixtures/tecassured-rate-utv-3-306.json"));
const RA = { id: "prov-ra", name: "Riders Advantage" };
const S = "44444444-4444-4444-8444-444444444444";
const X = "55555555-5555-4555-8555-555555555555";

const slot = (position, title, ids, mode = "Side by Side") => ({
  id: `s${position}`, template_id: "t", position, title, category: null, mode, product_ids: ids,
});

/** A one-tier BRP family, priced at `cost`. */
function brpFamily(code, cost) {
  return {
    family_code: code,
    provider_id: "prov-brp",
    provider_name: "BRP",
    tiers: [{
      product_code: code, product_name: `BRP ${code}`, product_type: code, raw: {},
      rates: [{ rate_unique: `r-${code}`, dealer_cost: cost, offered_price: null }],
    }],
  };
}

test("a single-family slot is that family; All deals gives back today's families", () => {
  const families = normalizeOffer(QUOTE, RA);
  const catalog = new Map();
  const slots = families.map((f, i) => {
    for (const t of f.tiers) catalog.set(`cat-${t.product_code}`, { provider_id: "prov-ra", product_code: t.product_code });
    return slot(i + 1, f.family_code, f.tiers.map((t) => `cat-${t.product_code}`));
  });
  const out = slotFamilies(resolveSlots(slots, families, catalog));
  assert.deepEqual(out, families);
});

test("a mixed Side by Side slot is one decision, cheapest first, each tier naming its provider", () => {
  const families = [...normalizeOffer(QUOTE, RA), brpFamily("BRP-B3", 1)];
  const vsa = families.find((f) => f.family_code === "VSA");
  const catalog = new Map([
    ["brp", { provider_id: "prov-brp", product_code: "BRP-B3" }],
    ...vsa.tiers.map((t) => [`ra-${t.product_code}`, { provider_id: "prov-ra", product_code: t.product_code }]),
  ]);
  const [mixed, hidden] = slotFamilies(
    resolveSlots(
      [slot(2, "Mechanical Protection", [...vsa.tiers.map((t) => `ra-${t.product_code}`), "brp"]), slot(3, "Nothing", ["none"])],
      families,
      catalog
    )
  ).concat([undefined]);
  assert.equal(hidden, undefined, "a hidden slot is left out");
  assert.equal(mixed.family_code, "slot-2");
  assert.equal(mixed.provider_id, null);
  assert.equal(mixed.tiers[0].product_code, "BRP-B3");
  assert.equal(mixed.tiers[0].provider_name, "BRP");
  assert.ok(mixed.tiers.slice(1).every((t) => t.provider_id === "prov-ra"));
  assert.equal(mixed.tiers.length, vsa.tiers.length + 1);
});

test("product copy is found by provider and code, so two providers may share a code", () => {
  const byCode = indexCatalog([
    { product_code: "A", provider_id: "prov-ra", store_id: null, display_name: "RA A", is_presentable: true },
    { product_code: "A", provider_id: "prov-brp", store_id: null, display_name: "BRP A", is_presentable: false },
  ]);
  assert.equal(byCode.get(catalogKey("prov-brp", "A")).display_name, "BRP A");
  const coverage = classifyCoverage(
    [
      { product_code: "A", product_name: "A", provider_id: "prov-ra" },
      { product_code: "A", product_name: "A", provider_id: "prov-brp" },
    ],
    byCode
  );
  assert.equal(coverage.matched, 2);
  assert.deepEqual(coverage.copy_pending, [{ product_code: "A", display_name: "BRP A" }]);
  // A row with no provider keeps its old key.
  assert.equal(catalogKey(null, "16_3"), "16_3");
});

test("a published sheet adds its products to the catalog with a name and no wording", () => {
  const rows = newCatalogRows(
    [
      { product_code: "B3", product_name: "BRP Extended Service Terms", category: "Mechanical Protection" },
      { product_code: "B3", product_name: "BRP Extended Service Terms", category: "Mechanical Protection" },
      { product_code: "OLD", product_name: "Already there", category: "Theft" },
      { product_code: "OUT", product_name: "Left out", category: "Theft", left_out: true },
    ],
    new Set(["OLD"]),
    "tenant",
    "prov-brp"
  );
  assert.deepEqual(rows, [{
    tenant_id: "tenant", store_id: null, provider_id: "prov-brp", product_code: "B3",
    display_name: "BRP Extended Service Terms", category: "Mechanical Protection", goal: "Keep ownership manageable",
  }]);
  assert.equal(goalFor("Theft"), "Keep the asset valuable");
  assert.equal(goalFor(null), "Keep ownership enjoyable");
  const fn = src("../supabase/functions/fni-price-sheets/index.ts");
  assert.match(fn, /const catalog = await addToCatalog\(supabase, sheet, rates\);/);
  // No customer wording is ever generated for it.
  assert.doesNotMatch(src("../supabase/functions/_shared/oem-contracts.ts"), /what_it_covers/);
});

test("product wording is written by a person and says what is still missing", () => {
  assert.deepEqual(wordingMissing({ active: true, transferable: null }), [
    "what it accomplishes", "what it covers", "how long it lasts", "what it excludes",
    "how to use it", "whether it transfers", "a link to the full terms",
  ]);
  const ok = parseWording({ display_name: "BRP B3", goal: "Keep ownership manageable", transferable: "Yes", full_terms_url: "https://brp.example/terms", active: "on" });
  assert.equal(ok.fields.transferable, true);
  assert.equal(ok.fields.what_it_covers, null);
  assert.deepEqual(parseWording({ display_name: "", goal: "x", transferable: "Maybe", full_terms_url: "brp.com" }).errors, [
    "Give the product the name customers see.",
    "Choose which goal the product serves.",
    "Transfers must be Yes, No, or not answered yet.",
    "The full terms link must start with https://.",
  ]);
  const page = src("../apps/ownership-planner/app/admin/providers/wording/page.tsx");
  assert.match(page, /const operator = await currentOperator\(\);\s*if \(!operator\) return null;/);
  assert.doesNotMatch(page, /\u2014/);
  assert.doesNotMatch(src("../supabase/functions/fni-admin-settings/wording.ts"), /\.delete\(/);
});

test("migration 0027 is additive: four columns, a check, a private bucket", () => {
  const sql = src("../supabase/migrations/0027_oem_contracts.sql");
  assert.doesNotMatch(sql, /drop/i);
  for (const c of ["recorded_by text", "recorded_at timestamptz", "void_reason text", "document_path text"]) {
    assert.match(sql, new RegExp(`add column if not exists ${c}`));
  }
  assert.match(sql, /'oem-contracts', 'oem-contracts', false/);
});

test("a recorded contract reads as Recorded and needs a number, a person and its document", () => {
  assert.equal(contractStateLabel({ status: "Live", recorded_by: "jim@example.com" }), "Recorded");
  assert.equal(contractStateLabel({ status: "Live", recorded_by: null }), "Live");
  assert.equal(contractStateLabel({ status: "Voided", recorded_by: "jim@example.com" }), "Voided");
  assert.ok(isRecorded({ recorded_by: "jim" }) && !isRecorded({ recorded_by: null }));

  const path = `${S}/${X}/signed.pdf`;
  const ok = parseRecord({ selected_product_id: X, contract_number: " BRP-123 ", recorded_by: "jim", document_path: path }, S);
  assert.deepEqual(ok.fields, { selected_product_id: X, contract_number: "BRP-123", recorded_by: "jim", document_path: path, filename: "signed.pdf" });
  // A document from another deal is not this deal's.
  assert.deepEqual(parseRecord({ selected_product_id: X, contract_number: "1", recorded_by: "jim", document_path: `${X}/${S}/a.pdf` }, S).errors, [
    "Upload the signed contract first.",
  ]);
  assert.deepEqual(parseVoid({ contract_number: "1", voided_by: "jim" }).errors, ["Say why this contract is being voided."]);
  assert.deepEqual(documentPathFor(S, "contract.docx", X), { error: "The signed contract must be a PDF, JPG or PNG." });
  assert.deepEqual(documentPathFor(S, "My Contract.PDF", X), { path: `${S}/${X}/My-Contract.PDF` });
});

test("submit holds OEM selections back, before the lock, and reports them", () => {
  const sels = [{ rate_unique: "ra-1" }, { rate_unique: "brp-1" }];
  assert.deepEqual(splitSelections(sels, new Set(["brp-1"])), {
    toProvider: [{ rate_unique: "ra-1" }], recordedByStaff: [{ rate_unique: "brp-1" }],
  });
  const fn = src("../supabase/functions/fni-contract-submit/index.ts");
  const split = fn.indexOf("splitSelections(body.selections");
  assert.ok(split > 0 && split < fn.indexOf("lockToken = crypto.randomUUID()"));
  assert.ok(split < fn.indexOf("createTecAssuredClient("));
  assert.match(fn, /Every selection is an OEM product/);
  assert.equal((fn.match(/recorded_by_staff: recordedByStaffReport/g) ?? []).length, 3);
  // A recorded OEM contract never blocks a Riders Advantage product.
  assert.match(fn, /\.eq\("provider_id", store\.providerId\)\s*\.is\("recorded_by", null\)/);
});

test("void refuses a recorded OEM contract before TecAssured is reached", () => {
  const fn = src("../supabase/functions/fni-contract-void/index.ts");
  const guard = fn.indexOf("if (isRecorded(row))");
  assert.ok(guard > 0 && guard < fn.indexOf("createTecAssuredClient(session.store_id"));
  assert.match(fn, /Nothing was sent to TecAssured\./);
});

test("fni-oem-contracts never calls a provider and never deletes", () => {
  const fn = src("../supabase/functions/fni-oem-contracts/index.ts") + src("../supabase/functions/_shared/oem-contract-rows.ts");
  assert.doesNotMatch(fn, /from "[^"]*tecassured/i);
  assert.doesNotMatch(fn, /createTecAssuredClient|voidContract|submitContract/);
  assert.doesNotMatch(fn, /\.delete\(|\.remove\(/);
  assert.match(fn, /createSignedUploadUrl\(target\.path\)/);
  assert.match(src("../supabase/config.toml"), /\[functions\.fni-oem-contracts\]\nverify_jwt = false/);
});

test("Verify shows hidden slots, and records OEM contracts from the browser straight to the bucket", () => {
  const page = src("../apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(page, /sheet\.hidden_slots!\.map/);
  assert.match(page, /<OemContractRecord sessionId=\{sheet\.session\.id\}/);
  assert.match(page, /c\.status === "Recorded" \?/);
  const upload = src("../apps/ownership-planner/components/OemContractRecord.tsx");
  assert.match(upload, /^"use client";/);
  assert.match(upload, /fetch\(started\.signed_url, \{ method: "PUT", body/);
  const verify = src("../supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /hidden_slots: \(resolved \?\? \[\]\)/);
  assert.match(verify, /oem_contracts: oemContracts,/);
});
