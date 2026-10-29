// Filing a session's held contract documents into the Deal Jacket when the
// CRM gives the deal its folders (zoho-sync, migration 0041), and the claim
// that stops two callers filing the same contract at once. Mock data only:
// every ID, number and name here is invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALREADY_FILED,
  BEING_FILED,
  FILE_CLAIM_STALE_MS,
  FILED_EVENT,
  FILING_FAILED_EVENT,
  NOT_FILED_EVENT,
  NOTHING_HELD,
  SAVED,
  WAITING,
  filingEvents,
  moveHeldDocuments,
  unclaimedFilingFilter,
} from "../supabase/functions/_shared/deal-jacket-move.ts";
import { resolveFolders } from "../supabase/functions/_shared/deal-jacket-request.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const FOLDERS = { deal_jacket_folder_id: "jacketSample01", signed_documents_folder_id: "signedSample01" };

const held = (id, over = {}) => ({
  id, contract_number: `RA-SAMPLE-${id}`, document_name: `TA01 MUI #10001 Sample Buyer Sample Product RA-SAMPLE-${id}`,
  document_storage_path: `s/${id}.pdf`, document_status: WAITING, workdrive_file_id: null, ...over,
});

/** A table with one claim column, applied the way the conditional UPDATE is. */
function fakes({ claimedBy = {}, failUpload = false } = {}) {
  const rows = {};
  const log = { uploaded: [], released: [], recorded: [] };
  let n = 0;
  return {
    rows, log,
    deps: {
      claim: async (id) => {
        if (claimedBy[id] || rows[id]?.workdrive_file_id) return false;
        claimedBy[id] = "this call";
        return true;
      },
      release: async (id) => { delete claimedBy[id]; log.released.push(id); },
      download: async () => new Uint8Array([37, 80, 68, 70]),
      listJacket: async () => [],
      trash: async () => {},
      upload: async (_folder, name) => {
        if (failUpload) throw new Error("refused");
        log.uploaded.push(name);
        return `wd-${++n}`;
      },
      record: async (id, fields) => {
        rows[id] = { ...(rows[id] ?? {}), ...fields };
        if (fields.filing_started_at === null) delete claimedBy[id];
        log.recorded.push({ id, ...fields });
      },
      now: () => "2026-10-29T12:00:00.000Z",
      problem: () => "WorkDrive did not take the file just now. Run the move again.",
    },
    claimedBy,
  };
}

test("each contract is claimed before it is filed, and the record ends the claim", async () => {
  const f = fakes();
  const lines = await moveHeldDocuments([held("1"), held("2")], FOLDERS, f.deps);
  assert.deepEqual(lines.map((l) => [l.moved, l.outcome]), [[true, "Saved to Deal Jacket."], [true, "Saved to Deal Jacket."]]);
  assert.deepEqual(f.log.recorded.map((r) => [r.id, r.deal_jacket_folder_id, r.filing_started_at, r.document_status]), [
    ["1", "jacketSample01", null, SAVED],
    ["2", "jacketSample01", null, SAVED],
  ]);
  assert.deepEqual(f.claimedBy, {});
});

test("a contract another request is filing is left alone, and nothing is sent for it", async () => {
  const f = fakes({ claimedBy: { 2: "Get document" } });
  const lines = await moveHeldDocuments([held("1"), held("2")], FOLDERS, f.deps);
  assert.deepEqual(lines.map((l) => [l.moved, l.outcome]), [[true, "Saved to Deal Jacket."], [false, BEING_FILED]]);
  assert.equal(f.log.uploaded.length, 1);
  // Its claim is the other request's, and is not released by this one.
  assert.equal(f.claimedBy[2], "Get document");
  assert.deepEqual(f.log.released, []);
});

test("two callers at once file each contract once", async () => {
  const shared = {};
  const a = fakes({ claimedBy: shared });
  const b = fakes({ claimedBy: shared });
  // The second caller claims while the first holds the row.
  const docs = [held("1")];
  const first = moveHeldDocuments(docs, FOLDERS, a.deps);
  const second = moveHeldDocuments(docs, FOLDERS, b.deps);
  const [x, y] = await Promise.all([first, second]);
  assert.deepEqual([x[0].moved, y[0].moved].sort(), [false, true]);
  assert.equal(a.log.uploaded.length + b.log.uploaded.length, 1);
});

test("a filing that fails gives its claim back, so the next one can file it", async () => {
  const f = fakes({ failUpload: true });
  const [line] = await moveHeldDocuments([held("1")], FOLDERS, f.deps);
  assert.equal(line.moved, false);
  assert.deepEqual(f.log.released, ["1"]);
  assert.deepEqual(f.claimedBy, {});
});

test("a claim older than five minutes is taken to be abandoned", () => {
  assert.equal(FILE_CLAIM_STALE_MS, 5 * 60 * 1000);
  assert.equal(
    unclaimedFilingFilter(new Date("2026-10-29T12:10:00.000Z")),
    "filing_started_at.is.null,filing_started_at.lt.2026-10-29T12:05:00.000Z"
  );
  const live = read("supabase/functions/_shared/deal-jacket-live.ts");
  assert.match(live, /\.update\(\{ filing_started_at: new Date\(\)\.toISOString\(\) \}\)\s*\.eq\("id", rowId\)\s*\.is\("workdrive_file_id", null\)\s*\.or\(unclaimedFilingFilter\(new Date\(\)\)\)/);
});

test("the session's folders come before dc.deals; the call's before both", () => {
  const session = { deal_jacket_folder_id: "jacketSession1", signed_documents_folder_id: "signedSession1" };
  const dc = { deal_jacket_folder_id: "jacketDc00001", signed_documents_folder_id: "signedDc00001" };
  const none = { deal_jacket_folder_id: null, signed_documents_folder_id: null };
  assert.deepEqual(resolveFolders(none, dc, session), { folders: session, source: "The session" });
  assert.deepEqual(resolveFolders(none, dc, null), { folders: dc, source: "DocuRide DC" });
  assert.deepEqual(resolveFolders({ deal_jacket_folder_id: "jacketCall001", signed_documents_folder_id: null }, dc, session), {
    folders: { deal_jacket_folder_id: "jacketCall001", signed_documents_folder_id: "signedSession1" },
    source: "This call and the session",
  });
  assert.deepEqual(resolveFolders(none, dc, { deal_jacket_folder_id: "jacketSession1", signed_documents_folder_id: null }), {
    folders: { deal_jacket_folder_id: "jacketSession1", signed_documents_folder_id: "signedDc00001" },
    source: "The session and DocuRide DC",
  });
  assert.equal(resolveFolders(none, null, { deal_jacket_folder_id: "jacketSession1", signed_documents_folder_id: null }), null);
});

test("the session events: a count when filed, one per contract that was not", () => {
  const events = filingEvents([
    { contract_number: "RA-SAMPLE-1", file_name: "x", outcome: "Saved to Deal Jacket.", moved: true },
    { contract_number: "RA-SAMPLE-2", file_name: "x", outcome: "Saved to Deal Jacket, marked VOID.", moved: true },
    { contract_number: "RA-SAMPLE-3", file_name: "x", outcome: "WorkDrive did not take the file just now. Run the move again.", moved: false },
    { contract_number: "RA-SAMPLE-4", file_name: "x", outcome: ALREADY_FILED, moved: false },
    { contract_number: "RA-SAMPLE-5", file_name: "x", outcome: NOTHING_HELD, moved: false },
    { contract_number: "RA-SAMPLE-6", file_name: "x", outcome: BEING_FILED, moved: false },
  ]);
  assert.deepEqual(events, [
    { event: FILED_EVENT, detail: { count: 2, contract_numbers: ["RA-SAMPLE-1", "RA-SAMPLE-2"] } },
    { event: NOT_FILED_EVENT, detail: { contract_number: "RA-SAMPLE-3", reason: "WorkDrive did not take the file just now. Run the move again." } },
  ]);
  assert.equal(FILED_EVENT, "Contracts filed to Deal Jacket when CRM created the deal's folders");
  assert.equal(NOT_FILED_EVENT, "Contract not filed to Deal Jacket");
  // Nothing waiting: no event at all.
  assert.deepEqual(filingEvents([]), []);
  // Never a file name, which holds the buyer's name.
  assert.doesNotMatch(JSON.stringify(events), /file_name|Sample Buyer/);
  for (const e of [FILED_EVENT, NOT_FILED_EVENT, FILING_FAILED_EVENT]) assert.doesNotMatch(e, /—|DX1/);
});

test("zoho-sync's filing never throws, signs its events System, and never names a folder", () => {
  const file = read("supabase/functions/_shared/deal-jacket-file.ts");
  const fn = file.slice(file.indexOf("export async function fileWhenFoldersReady("));
  assert.match(fn, /\} catch \(err\) \{\s*events = \[\{\s*event: FILING_FAILED_EVENT,/);
  assert.match(fn, /created_by: "System"/);
  // The session's folders first; dc.deals only when one is missing.
  assert.match(fn, /const dc = s\.deal_jacket_folder_id && s\.signed_documents_folder_id\s*\? null\s*: await dcDealFolders\(/);
  assert.match(fn, /resolveFolders\(\{ deal_jacket_folder_id: null, signed_documents_folder_id: null \}, dc, s\)/);
  assert.doesNotMatch(fn, /console\.\w+\([^)]*(folder_id|file_name|buyer)/);
  // Every caller files through the same function.
  assert.match(read("supabase/functions/fni-documents-to-deal-jacket/index.ts"), /await fileHeldDocuments\(supabase, found\.map\(\(s\) => s\.id\), resolved\.folders\)/);
});
