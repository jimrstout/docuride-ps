// Verify shows each contract's document status in plain English, gives a
// short-lived link to a held PDF, and lets staff move held documents into the
// Deal Jacket by hand. Voiding a waiting document marks it so it moves with
// " VOID".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { documentBaseName, routedFileName, voidedBaseName } from "../supabase/functions/_shared/document-names.ts";
import { jacketName, VOIDED } from "../supabase/functions/_shared/deal-jacket-move.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("voiding a waiting document marks its record Voided with VOID in its stored name", () => {
  const fn = src("../supabase/functions/fni-contract-void/index.ts");
  assert.match(fn, /document_status: "Voided",\s*document_name: row\.document_name \? voidedBaseName\(row\.document_name\) : null,/);
  // Only after TecAssured has voided it, and the bucket copy is left alone.
  assert.ok(fn.indexOf("client.voidContract(") < fn.indexOf('document_status: "Voided"'));
  assert.doesNotMatch(fn, /storage\.from|\.remove\(|\.move\(/);

  // And it then lands in the Deal Jacket with VOID before the first pipe.
  const base = documentBaseName({ prefix: "TA", position: 2, deal_number: "13759", buyer_display_name: "A B", product_name: "Theft", contract_number: "RA2" });
  const name = jacketName(
    { id: "r", contract_number: "RA2", document_name: voidedBaseName(base), document_storage_path: "p", document_status: VOIDED, workdrive_file_id: null },
    { deal_jacket_folder_id: "j", signed_documents_folder_id: "s" }
  );
  assert.equal(name, routedFileName(`${base} VOID`, "s"));
  assert.equal(name, "TA02 MUI #13759 A B Theft RA2 VOID|SignedDocuRideDC|s|.pdf");
});

test("the sheet gives a ten-minute link to a held PDF and never the storage path", () => {
  const verify = src("../supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /\.from\(HOLD_BUCKET\)\s*\.createSignedUrl\(String\(c\.document_storage_path\), 600\)/);
  assert.match(verify, /const \{ document_storage_path: _path, [^}]*\.\.\.shown \} = c;/);
  assert.match(verify, /waiting_count: waiting/);
});

test("the panel says the status in plain English, and the move button says what it is doing", () => {
  const page = src("../apps/ownership-planner/app/verify/[sessionId]/page.tsx");
  assert.match(page, />Waiting for Deal Jacket</);
  assert.match(page, />Saved to Deal Jacket</);
  assert.match(page, /View PDF/);
  assert.match(page, /<PendingButton pending="Moving documents\.\.\.">Move documents to Deal Jacket<\/PendingButton>/);
  assert.doesNotMatch(page, /—/);
  const actions = src("../apps/ownership-planner/app/console-actions.ts");
  // The button makes the same call the CRM will.
  assert.match(actions, /edge\.documentsToDealJacket\(\{ session_id: sessionId \}\)/);
  assert.match(src("../apps/ownership-planner/lib/edge.ts"), /call<T>\("fni-documents-to-deal-jacket", \{ method: "POST", body \}\)/);
});
