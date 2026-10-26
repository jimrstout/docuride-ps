// A provider's contract document in the deal's Deal Jacket:
//   {prefix}{nn} MUI #{deal} {buyer} {product} {contract}|SignedDocuRideDC|{signed folder id}|.pdf
// with DocuRide DC's own character cleanup, so ours sit alongside DC's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cleanName,
  contractDocumentName,
  contractFileName,
  positionCode,
  sameDocument,
  voidedName,
} from "../supabase/functions/_shared/document-names.ts";
import { assignPositions, folderProblem, MISSING_FOLDER, prefixProblem } from "../supabase/functions/_shared/contract-documents.ts";
import { fromBase64, isPdf, pageSizes, withoutPdf } from "../supabase/functions/_shared/pdf-pages.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const parts = {
  prefix: "TA",
  position: 1,
  deal_number: "13759",
  buyer_display_name: "Chad Baber",
  product_name: "Mechanical Protection",
  contract_number: "RA123456",
  signed_documents_folder_id: "abc123signed",
};

test("the name follows the schema, with the closing pipe and .pdf as WorkDrive shows DC's", () => {
  assert.equal(
    contractDocumentName(parts),
    "TA01 MUI #13759 Chad Baber Mechanical Protection RA123456|SignedDocuRideDC|abc123signed|"
  );
  assert.equal(
    contractFileName({ ...parts, position: 12 }),
    "TA12 MUI #13759 Chad Baber Mechanical Protection RA123456|SignedDocuRideDC|abc123signed|.pdf"
  );
  assert.equal(positionCode(3), "03");
  assert.throws(() => positionCode(0));
  assert.throws(() => positionCode(100));
});

test("DocuRide DC's cleanup: \\ / : * ? \" < > become -, double spaces collapse, pipes stay", () => {
  assert.equal(cleanName('A/B\\C:D*E?F"G<H>I  J|K'), "A-B-C-D-E-F-G-H-I J|K");
  assert.equal(
    contractDocumentName({ ...parts, buyer_display_name: "Smith  &  Sons, LLC", product_name: "Tire/Wheel: Plus" }),
    "TA01 MUI #13759 Smith & Sons, LLC Tire-Wheel- Plus RA123456|SignedDocuRideDC|abc123signed|"
  );
  // The same regular expressions as docuride-dc's _shared/dc-folders.ts cleanName.
  const mine = src("../supabase/functions/_shared/document-names.ts");
  assert.ok(mine.includes('return name.replace(/[\\\\/:*?"<>]/g, "-").replace(/ {2,}/g, " ");'));
});

test("a file is the same document with or without .pdf; voiding adds VOID before the first pipe", () => {
  const name = contractFileName(parts);
  assert.ok(sameDocument(name, name));
  assert.ok(sameDocument(name.slice(0, -4), name));
  assert.ok(!sameDocument(voidedName(name), name));
  assert.equal(
    voidedName(name),
    "TA01 MUI #13759 Chad Baber Mechanical Protection RA123456 VOID|SignedDocuRideDC|abc123signed|.pdf"
  );
  assert.equal(voidedName(voidedName(name)), voidedName(name));
});

test("no Deal Jacket or Signed Documents folder is Missing Folder; no prefix is refused", () => {
  assert.equal(MISSING_FOLDER, "Missing Folder");
  assert.match(folderProblem(null), /not in DocuRide DC yet/);
  assert.match(
    folderProblem({ deal_number: "1", buyer_display_name: "A", deal_jacket_folder_id: "j", signed_documents_folder_id: null }),
    /no Deal Jacket or Signed Documents folder/
  );
  assert.equal(
    folderProblem({ deal_number: "1", buyer_display_name: "A", deal_jacket_folder_id: "j", signed_documents_folder_id: "s" }),
    null
  );
  assert.equal(
    prefixProblem({ name: "BRP", document_prefix: null }),
    "BRP has no document prefix, so its documents cannot be sent to WorkDrive. Set one in Admin > Providers, then try again."
  );
  assert.equal(prefixProblem({ name: "Riders Advantage", document_prefix: "TA" }), null);
});

test("places are kept once given; contracts without one follow, in recorded order", () => {
  const places = assignPositions([
    { id: "a", document_position: 2, created_at: "2026-10-26T01:00:00Z" },
    { id: "b", document_position: null, created_at: "2026-10-26T03:00:00Z" },
    { id: "c", document_position: null, created_at: "2026-10-26T02:00:00Z" },
  ]);
  assert.deepEqual([...places.entries()].sort(), [["a", 2], ["b", 4], ["c", 3]]);
});

test("pages are counted and measured in points; the provider's answer is kept except the PDF", () => {
  const doc = {
    getPages: () => [
      { getSize: () => ({ width: 612, height: 792 }), getRotation: () => ({ angle: 0 }) },
      { getSize: () => ({ width: 792, height: 612 }), getRotation: () => ({ angle: 90 }) },
    ],
  };
  assert.deepEqual(pageSizes(doc), {
    page_count: 2,
    page_sizes: [
      { page: 1, width: 612, height: 792, rotation: 0 },
      { page: 2, width: 792, height: 612, rotation: 90 },
    ],
  });
  const answer = { data: "JVBERi0=", signatures: [{ type: "buyer", page: 1, left: 1.5, extra: { x: 1 } }], pdfLink: "l" };
  assert.deepEqual(withoutPdf(answer), { signatures: answer.signatures, pdfLink: "l" });
  assert.ok(isPdf(fromBase64("JVBERi0xLjQK")));
  assert.ok(!isPdf(fromBase64("PGh0bWw+")));
});

test("contract-documents checks the rule, the prefix and the folders before asking TecAssured", () => {
  const fn = src("../supabase/functions/fni-contract-documents/index.ts");
  const ask = fn.indexOf("client.getContractDocument(");
  for (const needle of ["contractCallRefusal(session", "prefixProblem(provider", "folderProblem(deal)"]) {
    const at = fn.indexOf(needle);
    assert.ok(at > 0 && at < ask, needle);
  }
  // Signature data stored exactly as returned; the PDF itself is not returned.
  assert.match(fn, /provider_signatures: doc\.signatures \?\? null,/);
  assert.doesNotMatch(fn, /pdf_base64:/);
  // Replace, don't duplicate; never a delete.
  assert.ok(fn.indexOf("trashFile(f.id)") < fn.indexOf("uploadPdf("));
  assert.doesNotMatch(fn + src("../supabase/functions/_shared/workdrive.ts"), /method: "DELETE"/);
  // No folder code of our own.
  assert.doesNotMatch(src("../supabase/functions/_shared/workdrive.ts"), /createFolder/);
});

test("WorkDrive uses DocuRide DC's client and token row, and never logs a token", () => {
  const z = src("../supabase/functions/_shared/dc-zoho.ts");
  assert.match(z, /ZOHO_DC_CLIENT_ID/);
  assert.match(z, /from dc\.zoho_dc_token where id = 1 for update/);
  assert.doesNotMatch(z, /console\.(log|error|warn)/);
  const sql = src("../supabase/migrations/0029_contract_documents_workdrive.sql");
  assert.doesNotMatch(sql, /drop/i);
  for (const c of ["document_position integer", "workdrive_file_id text", "workdrive_file_name text", "workdrive_saved_at timestamptz", "provider_signatures jsonb", "provider_document jsonb", "page_count integer", "page_sizes jsonb"]) {
    assert.match(sql, new RegExp(`add column if not exists ${c}`));
  }
  const submit = src("../supabase/functions/fni-contract-submit/index.ts");
  assert.ok(submit.indexOf("row.document_position = next++") < submit.indexOf(".insert(productRows)"));
});
