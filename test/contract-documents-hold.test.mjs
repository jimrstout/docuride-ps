// Contract PDFs are held in the private fni-contracts bucket first, and moved
// into the Deal Jacket once DocuRide DC has made the deal's folders.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  contractFileName,
  documentBaseName,
  routedFileName,
  storageFileName,
  voidedBaseName,
} from "../supabase/functions/_shared/document-names.ts";
import { buyerNameFor, readyFolders } from "../supabase/functions/_shared/contract-documents.ts";
import { moveHeldDocuments, SAVED, VOIDED, WAITING } from "../supabase/functions/_shared/deal-jacket-move.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const parts = {
  prefix: "TA", position: 1, deal_number: "13759", buyer_display_name: "Chad Baber",
  product_name: "Mechanical Protection", contract_number: "RA123456",
};
const FOLDERS = { deal_jacket_folder_id: "jacket1", signed_documents_folder_id: "signed1" };

/** A stand-in WorkDrive, bucket and table that remembers what happened. */
function fakes({ jacket = [], held = { "s/a.pdf": new Uint8Array([37, 80, 68, 70]) } } = {}) {
  const log = { trashed: [], uploaded: [], recorded: [] };
  let n = 0;
  return {
    log,
    deps: {
      download: async (path) => held[path] ?? null,
      listJacket: async () => [...jacket],
      trash: async (id) => void log.trashed.push(id),
      upload: async (folder, name) => {
        log.uploaded.push({ folder, name });
        return `wd-${++n}`;
      },
      record: async (id, fields) => void log.recorded.push({ id, ...fields }),
      now: () => "2026-10-26T12:00:00.000Z",
      problem: () => "WorkDrive said no.",
    },
  };
}

const held = (over = {}) => ({
  id: "row1", contract_number: "RA123456", document_name: documentBaseName(parts),
  document_storage_path: "s/a.pdf", document_status: WAITING, workdrive_file_id: null, ...over,
});

test("the base name is stored now; the routing part is added when the folder id is known", () => {
  const base = documentBaseName(parts);
  assert.equal(base, "TA01 MUI #13759 Chad Baber Mechanical Protection RA123456");
  assert.equal(routedFileName(base, "signed1"), contractFileName({ ...parts, signed_documents_folder_id: "signed1" }));
  assert.equal(routedFileName(base, "signed1"), "TA01 MUI #13759 Chad Baber Mechanical Protection RA123456|SignedDocuRideDC|signed1|.pdf");
  // Storage keys take no "#" or accents; the WorkDrive name keeps them.
  assert.equal(storageFileName("TA01 MUI #13759 José Núñez Theft RA9"), "TA01 MUI -13759 Jos- N--ez Theft RA9.pdf");
  assert.equal(voidedBaseName(voidedBaseName(base)), `${base} VOID`);
});

test("with folders a held document is saved to the Deal Jacket; without them it waits", async () => {
  assert.equal(readyFolders({ deal_jacket_folder_id: "j", signed_documents_folder_id: null }), null);
  assert.equal(readyFolders(null), null);
  assert.deepEqual(readyFolders({ deal_jacket_folder_id: " j ", signed_documents_folder_id: "s" }), {
    deal_jacket_folder_id: "j", signed_documents_folder_id: "s",
  });

  const { deps, log } = fakes({ jacket: [{ id: "old", name: routedFileName(documentBaseName(parts), "signed1") }] });
  const [line] = await moveHeldDocuments([held()], FOLDERS, deps);
  assert.equal(line.moved, true);
  assert.equal(line.outcome, "Saved to Deal Jacket.");
  assert.deepEqual(log.trashed, ["old"]);
  assert.deepEqual(log.uploaded, [{ folder: "jacket1", name: line.file_name }]);
  assert.equal(log.recorded[0].document_status, SAVED);
  assert.equal(log.recorded[0].workdrive_file_id, "wd-1");

  // Without folders, Get document holds and does not stop with Missing Folder.
  const fn = src("../supabase/functions/fni-contract-documents/index.ts");
  assert.doesNotMatch(fn, /MISSING_FOLDER|Missing Folder\./);
  assert.ok(fn.indexOf(".from(HOLD_BUCKET)") < fn.indexOf("if (folders) {"));
  assert.match(fn, /record\.document_status = WAITING;/);
});

test("a voided waiting document moves with VOID before the first pipe and stays Voided", async () => {
  const { deps, log } = fakes();
  const [line] = await moveHeldDocuments([held({ document_status: VOIDED })], FOLDERS, deps);
  assert.equal(line.file_name, "TA01 MUI #13759 Chad Baber Mechanical Protection RA123456 VOID|SignedDocuRideDC|signed1|.pdf");
  assert.equal(line.outcome, "Saved to Deal Jacket, marked VOID.");
  assert.equal(log.recorded[0].document_status, VOIDED);
});

test("a document already in the Deal Jacket, or with nothing held, is skipped and nothing changes", async () => {
  const { deps, log } = fakes();
  const lines = await moveHeldDocuments(
    [held({ workdrive_file_id: "wd-9", document_status: SAVED }), held({ id: "row2", document_storage_path: null })],
    FOLDERS,
    deps
  );
  assert.deepEqual(lines.map((l) => l.moved), [false, false]);
  assert.equal(lines[0].outcome, "Already in the Deal Jacket. Nothing changed.");
  assert.deepEqual([log.trashed, log.uploaded, log.recorded], [[], [], []]);
});

test("the buyer's name is DC's, or the session's while the deal is not in DC", () => {
  assert.equal(buyerNameFor({ buyer_display_name: "DC Name" }, "Session Name"), "DC Name");
  assert.equal(buyerNameFor(null, "Session Name"), "Session Name");
  assert.equal(buyerNameFor({ buyer_display_name: "" }, null), null);
});

test("migration 0030: private PDF-only bucket, three columns, nothing removed", () => {
  const sql = src("../supabase/migrations/0030_contract_documents_bucket.sql");
  assert.doesNotMatch(sql, /drop/i);
  assert.match(sql, /values \('fni-contracts', 'fni-contracts', false, 26214400, array\['application\/pdf'\]\)/);
  for (const c of ["document_storage_path text", "document_name text", "document_status text"]) {
    assert.match(sql, new RegExp(`add column if not exists ${c}`));
  }
  assert.match(sql, /'Waiting for Deal Jacket', 'Saved to Deal Jacket', 'Voided'/);
  assert.match(src("../supabase/functions/_shared/deal-jacket-live.ts"), /export const HOLD_BUCKET = "fni-contracts";/);
});
