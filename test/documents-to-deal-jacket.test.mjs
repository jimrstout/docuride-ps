// fni-documents-to-deal-jacket: the call the CRM makes once DocuRide DC has
// made a deal's folders, which moves the documents PS holds into the Deal
// Jacket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MISSING_FOLDER_MESSAGE, parseMoveRequest, resolveFolders } from "../supabase/functions/_shared/deal-jacket-request.ts";
import { moveHeldDocuments, SAVED, WAITING } from "../supabase/functions/_shared/deal-jacket-move.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const JACKET = "c4osdd39bf84457e94f58a4ac137c8725835c";
const SIGNED = "abcd1234efgh5678ijkl9012mnop3456qrst";

test("the call names the deal by record id or deal number; bad values are refused", () => {
  assert.deepEqual(parseMoveRequest({ record_id: "4742556000231058020" }).request, {
    record_id: "4742556000231058020", deal_number: null, session_id: null,
    deal_jacket_folder_id: null, signed_documents_folder_id: null,
  });
  assert.equal(parseMoveRequest({ deal_number: 13759 }).request.deal_number, "13759");
  assert.match(parseMoveRequest({}).error, /send record_id/);
  assert.equal(parseMoveRequest({ record_id: "abc" }).error, "record_id is not a Zoho record id.");
  assert.equal(
    parseMoveRequest({ deal_number: "1", deal_jacket_folder_id: "../x" }).error,
    "deal_jacket_folder_id is not a WorkDrive folder id."
  );
});

test("folder ids passed in win over dc.deals, one by one", () => {
  const dc = { deal_jacket_folder_id: "dcjacket", signed_documents_folder_id: "dcsigned" };
  assert.deepEqual(resolveFolders({ deal_jacket_folder_id: JACKET, signed_documents_folder_id: SIGNED }, dc), {
    folders: { deal_jacket_folder_id: JACKET, signed_documents_folder_id: SIGNED }, source: "This call",
  });
  assert.deepEqual(resolveFolders({ deal_jacket_folder_id: JACKET, signed_documents_folder_id: null }, dc), {
    folders: { deal_jacket_folder_id: JACKET, signed_documents_folder_id: "dcsigned" }, source: "This call and DocuRide DC",
  });
  assert.equal(resolveFolders({ deal_jacket_folder_id: null, signed_documents_folder_id: null }, dc).source, "DocuRide DC");
});

test("Missing Folder when neither has them, and the function changes nothing first", () => {
  assert.equal(resolveFolders({ deal_jacket_folder_id: JACKET, signed_documents_folder_id: null }, null), null);
  assert.equal(resolveFolders({ deal_jacket_folder_id: null, signed_documents_folder_id: null }, { deal_jacket_folder_id: "j", signed_documents_folder_id: null }), null);
  assert.match(MISSING_FOLDER_MESSAGE, /^Missing Folder\. .*Nothing was moved or changed\./);
  const fn = src("../supabase/functions/fni-documents-to-deal-jacket/index.ts");
  assert.ok(fn.indexOf("if (!resolved)") > 0);
  assert.ok(fn.indexOf("if (!resolved)") < fn.indexOf("fileHeldDocuments(supabase"));
  assert.doesNotMatch(fn, /\.from\("agreement_products"\)/);
});

test("calling twice moves nothing the second time", async () => {
  const rows = [{ id: "r1", contract_number: "RA1", document_name: "TA01 MUI #13759 A B RA1", document_storage_path: "s/a.pdf", document_status: WAITING, workdrive_file_id: null }];
  const uploads = [];
  const deps = {
    claim: async () => true,
    release: async () => {},
    download: async () => new Uint8Array([37, 80, 68, 70]),
    listJacket: async () => [],
    trash: async () => {},
    upload: async (_f, name) => (uploads.push(name), "wd-1"),
    // The table the endpoint reads back on the next call.
    record: async (id, fields) => Object.assign(rows.find((r) => r.id === id), fields),
    now: () => "2026-10-26T12:00:00.000Z",
    problem: () => "no",
  };
  const folders = { deal_jacket_folder_id: JACKET, signed_documents_folder_id: SIGNED };
  const first = await moveHeldDocuments(rows, folders, deps);
  const second = await moveHeldDocuments(rows, folders, deps);
  assert.deepEqual(first.map((l) => l.moved), [true]);
  assert.deepEqual(second.map((l) => [l.moved, l.outcome]), [[false, "Already in the Deal Jacket. Nothing changed."]]);
  assert.equal(uploads.length, 1);
  assert.equal(rows[0].document_status, SAVED);
});

test("only documents PS holds are moved; no provider is called; nothing is deleted; the secret is checked", () => {
  const fn = src("../supabase/functions/fni-documents-to-deal-jacket/index.ts");
  assert.match(fn, /secretsMatch\(presented, Deno\.env\.get\("FNI_WEBHOOK_SECRET"\)\)/);
  const file = src("../supabase/functions/_shared/deal-jacket-file.ts");
  assert.match(file, /\.is\("recorded_by", null\)\s*\.not\("document_storage_path", "is", null\)/);
  assert.doesNotMatch(file, /tecassured|contractCallRefusal/i);
  assert.doesNotMatch(fn, /tecassured|contractCallRefusal/i);
  assert.doesNotMatch(fn + src("../supabase/functions/_shared/deal-jacket-live.ts"), /\.remove\(|method: "DELETE"/);
  assert.doesNotMatch(fn, /console\.(log|error)\([^)]*(presented|secret)/i);
  assert.match(src("../supabase/config.toml"), /\[functions\.fni-documents-to-deal-jacket\]\nverify_jwt = false/);
  const doc = src("../docs/multi-provider.md");
  assert.match(doc, /functions\/v1\/fni-documents-to-deal-jacket/);
  assert.match(doc, /x-webhook-secret/);
});
