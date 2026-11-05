// A voided contract's file name (5 Nov 2026): "|VOID|" in front of the name
// exactly as it was, nothing else changed. Zoho Flow recognises voided
// contracts by that marker at the very front. Mock names only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isVoidedName, routedFileName, VOID_MARKER, voidedBaseName, voidedName } from "../supabase/functions/_shared/document-names.ts";
import { jacketName, VOIDED } from "../supabase/functions/_shared/deal-jacket-move.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const FILED = "TA02 MUI #99901 Sample Company SAMPLE T&W OFF-ROAD - SAMPLE TIRE & WHEEL TWOTE000000-0000|SignedDocuRideDC|signedfolder1|.pdf";

test("a filed file: |VOID| in front, the rest exactly as it was", () => {
  assert.equal(VOID_MARKER, "|VOID|");
  assert.equal(voidedName(FILED), `|VOID|${FILED}`);
  assert.equal(voidedName(FILED).slice(VOID_MARKER.length), FILED);
});

test("never marked twice, and a file voided the old way is not renamed", () => {
  assert.equal(voidedName(voidedName(FILED)), voidedName(FILED));
  const old = "TA02 MUI #99901 Sample Company SAMPLE PLAN TWOTE000000-0000 VOID|SignedDocuRideDC|signedfolder1|.pdf";
  assert.equal(voidedName(old), old);
  assert.ok(isVoidedName(old));
  assert.ok(isVoidedName(voidedName(FILED)));
  assert.ok(!isVoidedName(FILED));
});

test("a document waiting for its Deal Jacket lands with |VOID| in front, voided before or after the change", () => {
  const base = "TA01 MUI #99902 Sample Buyer SAMPLE BATTERY VLBT0000000-00000";
  const folders = { deal_jacket_folder_id: "jacket1", signed_documents_folder_id: "signed2" };
  const held = (document_name) => ({ id: "r", contract_number: "c", document_name, document_storage_path: "p", document_status: VOIDED, workdrive_file_id: null });
  const expected = `|VOID|${routedFileName(base, "signed2")}`;
  // Voided now: the stored name already carries the marker, and filing does not add it again.
  assert.equal(jacketName(held(voidedBaseName(base)), folders), expected);
  // Voided before the change (15029's two): stored with " VOID" on the end, they take the new marker instead.
  assert.equal(jacketName(held(`${base} VOID`), folders), expected);
  assert.equal(voidedBaseName(`${base} VOID`), `|VOID|${base}`);
});

test("PS only renames a voided file, by its id, wherever it is; it never moves or deletes one", () => {
  const fn = read("supabase/functions/fni-contract-void/index.ts");
  const mark = fn.slice(fn.indexOf("async function markFileVoid("), fn.indexOf("function json("));
  assert.match(mark, /await renameFile\(row\.workdrive_file_id, name\);/);
  assert.doesNotMatch(fn, /trashFile|moveFile|deleteFile|\.remove\(|storage\.from/);
});
