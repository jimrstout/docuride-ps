// Re-filing contracts to the Deal Jacket when the CRM regenerates a deal's
// documents (fni-documents-generated). On deal 13759 the regenerate rewrote
// the same folder IDs, so nothing filed, and the contracts still read as
// filed, so they would have been skipped anyway. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NO_FOLDERS,
  NO_SESSION,
  initialsOf,
  parseGenerated,
  queuedMessage,
} from "../supabase/functions/_shared/documents-generated.ts";
import {
  ALREADY_FILED,
  NOTHING_HELD,
  REFILED_EVENT,
  SAVED,
  VOIDED,
  WAITING,
  filingEvents,
  moveHeldDocuments,
} from "../supabase/functions/_shared/deal-jacket-move.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const FN = "supabase/functions/fni-documents-generated/index.ts";
const FOLDERS = { deal_jacket_folder_id: "jacketSample01", signed_documents_folder_id: "signedSample01" };

const doc = (id, over = {}) => ({
  id, contract_number: `RA-SAMPLE-${id}`, document_name: `TA0${id} MUI #10001 Sample Buyer Sample Product RA-SAMPLE-${id}`,
  document_storage_path: `s/${id}.pdf`, document_status: SAVED, workdrive_file_id: `wd-old-${id}`, ...over,
});

function fakes(jacket = []) {
  const log = { claims: [], trashed: [], uploaded: [], recorded: [] };
  let n = 0;
  return {
    log,
    deps: {
      claim: async (id, refile) => (log.claims.push([id, refile === true]), true),
      release: async () => {},
      download: async () => new Uint8Array([37, 80, 68, 70]),
      listJacket: async () => [...jacket],
      trash: async (id) => void log.trashed.push(id),
      upload: async (_f, name) => (log.uploaded.push(name), `wd-new-${++n}`),
      record: async (id, fields) => void log.recorded.push({ id, ...fields }),
      now: () => "2026-10-30T12:00:00.000Z",
      problem: () => "WorkDrive did not take the file just now. Run the move again.",
    },
  };
}

test("the request names the deal; who pressed Generate becomes initials, or System", () => {
  assert.deepEqual(parseGenerated({ zoho_deal_id: "4742556000231058020", initiated_by: " Sample Person " }), {
    request: { zoho_deal_id: "4742556000231058020", initiated_by: "Sample Person" },
  });
  assert.deepEqual(parseGenerated({}), { error: "zoho_deal_id is required: the CRM DocuRide record id." });
  assert.deepEqual(parseGenerated({ zoho_deal_id: "13759" }), { error: "zoho_deal_id is not a CRM record id." });
  assert.equal(parseGenerated({ zoho_deal_id: 4742556000231058020n.toString() }).request.initiated_by, null);
  assert.equal(initialsOf("Sample Person"), "SP");
  assert.equal(initialsOf("sample.person@example.com"), "SP");
  assert.equal(initialsOf("js"), "JS");
  assert.equal(initialsOf(null), "System");
  assert.equal(initialsOf("   "), "System");
});

test("a regenerate files every held document again: a filed one is not skipped", async () => {
  const name = (id) => `TA0${id} MUI #10001 Sample Buyer Sample Product RA-SAMPLE-${id}|SignedDocuRideDC|signedSample01|.pdf`;
  // Contract 1 is still in the Deal Jacket; contract 2 was moved out by signing.
  const f = fakes([{ id: "wd-old-1", name: name(1) }]);
  const lines = await moveHeldDocuments([doc("1"), doc("2"), doc("3", { document_status: VOIDED })], FOLDERS, f.deps, { refile: true });
  assert.deepEqual(lines.map((l) => l.moved), [true, true, true]);
  // Replaced by name: the one still there goes to the trash first.
  assert.deepEqual(f.log.trashed, ["wd-old-1"]);
  assert.equal(f.log.uploaded.length, 3);
  // A voided contract keeps VOID in its name.
  assert.match(f.log.uploaded[2], /RA-SAMPLE-3 VOID\|SignedDocuRideDC\|/);
  // The record is the new upload.
  assert.deepEqual(f.log.recorded.map((r) => [r.id, r.workdrive_file_id, r.deal_jacket_folder_id, r.filing_started_at]), [
    ["1", "wd-new-1", "jacketSample01", null],
    ["2", "wd-new-2", "jacketSample01", null],
    ["3", "wd-new-3", "jacketSample01", null],
  ]);
  // The claim is taken as a refile.
  assert.deepEqual(f.log.claims.map((c) => c[1]), [true, true, true]);
});

test("without a regenerate, a filed one is still skipped; nothing held is skipped either way", async () => {
  const f = fakes();
  const normal = await moveHeldDocuments([doc("1")], FOLDERS, f.deps);
  assert.deepEqual(normal.map((l) => l.outcome), [ALREADY_FILED]);
  const empty = await moveHeldDocuments([doc("4", { document_storage_path: null, workdrive_file_id: null, document_status: WAITING })], FOLDERS, f.deps, { refile: true });
  assert.deepEqual(empty.map((l) => l.outcome), [NOTHING_HELD]);
  assert.deepEqual(f.log.uploaded, []);
});

test("the refile claim takes a filed row; a first filing only an unfiled one", () => {
  const live = read("supabase/functions/_shared/deal-jacket-live.ts");
  assert.match(live, /async claim\(rowId, refile = false\) \{/);
  assert.match(live, /if \(!refile\) q = q\.is\("workdrive_file_id", null\);/);
  assert.match(live, /\.or\(unclaimedFilingFilter\(new Date\(\)\)\)/);
});

test("the events: a count when filed, one per contract that failed", () => {
  const events = filingEvents(
    [
      { contract_number: "RA-SAMPLE-1", file_name: "x", outcome: "Saved to Deal Jacket.", moved: true },
      { contract_number: "RA-SAMPLE-2", file_name: "x", outcome: "WorkDrive did not take the file just now. Run the move again.", moved: false },
    ],
    REFILED_EVENT
  );
  assert.equal(events[0].event, "Contracts filed to Deal Jacket after documents were regenerated");
  assert.deepEqual(events[0].detail, { count: 1, contract_numbers: ["RA-SAMPLE-1"] });
  assert.equal(events[1].event, "Contract not filed to Deal Jacket");
  const file = read("supabase/functions/_shared/deal-jacket-file.ts");
  assert.match(file, /fileHeldDocuments\(supabase, \[sessionId\], folders, deps, \{ refile: true \}\), REFILED_EVENT\)/);
  assert.match(file, /created_by: by \}\)\)\)/);
});

test("the endpoint: no session, no folders yet, or a regenerate answered at once", () => {
  const fn = read(FN);
  assert.equal(NO_SESSION, "No F&I session for this deal, nothing to file.");
  assert.equal(NO_FOLDERS, "Folders not created yet.");
  assert.equal(queuedMessage(4), "Documents regenerated. 4 contract documents are being filed to the Deal Jacket.");
  // Order: secret, request, session, folders, then the background filing.
  const at = (s) => fn.indexOf(s);
  assert.ok(at("secretsMatch(presented, configured)") < at("parseGenerated(body)"));
  assert.ok(at('.eq("zoho_deal_id", zoho_deal_id)') < at("if (!s) {"));
  assert.ok(at("if (!s) {") < at("if (!s.deal_jacket_folder_id) {"));
  assert.ok(at("if (!s.deal_jacket_folder_id) {") < at("refileAfterRegenerate("));
  assert.match(fn, /if \(typeof EdgeRuntime !== "undefined"\) EdgeRuntime\.waitUntil\(work\);/);
  assert.match(fn, /contracts_queued: held\.length,/);
  // A bad secret logs lengths only.
  assert.match(fn, /console\.warn\("fni-documents-generated auth failed", \{\s*configuredLength: configured\?\.length \?\? 0,\s*presentedLength: presented\?\.length \?\? 0,\s*\}\);/);
  // Never a folder ID, a name or a file name in a log.
  assert.doesNotMatch(fn, /console\.\w+\([^;]*(folder_id|initiated_by|document_name|file_name)/);
  assert.match(read("supabase/config.toml"), /\[functions\.fni-documents-generated\]\nverify_jwt = false/);
});
