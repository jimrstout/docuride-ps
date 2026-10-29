// zoho-sync keeps a deal's three WorkDrive folder IDs on its session through
// fni.record_deal_folders (migration 0041), and files the waiting documents
// when the folders become known. Mock data only: every ID here is invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEAL_JACKET_FIELD,
  SIGNED_DOCUMENTS_FIELD,
  SUPPORTING_DOCUMENTS_FIELD,
  dealFolderArgs,
  dealFolderLog,
} from "../supabase/functions/_shared/deal-folders.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const SYNC = "supabase/functions/zoho-sync/index.ts";

test("the CRM's field API names, exactly", () => {
  assert.equal(DEAL_JACKET_FIELD, "Deal_Jacket_Folder_ID");
  assert.equal(SUPPORTING_DOCUMENTS_FIELD, "Supporting_Documents_Folder_ID");
  assert.equal(SIGNED_DOCUMENTS_FIELD, "Signed_Documents_Folder_ID");
});

test("the three IDs go to the function by its parameter names, trimmed", () => {
  const record = {
    id: "9000000000001",
    Deal_Jacket_Folder_ID: " jacket-sample-1 ",
    Supporting_Documents_Folder_ID: "supporting-sample-1",
    Signed_Documents_Folder_ID: "signed-sample-1",
  };
  assert.deepEqual(dealFolderArgs(" 9000000000001 ", record), {
    p_zoho_deal_id: "9000000000001",
    p_deal_jacket: "jacket-sample-1",
    p_supporting: "supporting-sample-1",
    p_signed: "signed-sample-1",
  });
});

test("a blank, a missing field or a non-text value is sent as null, for the function to judge", () => {
  const args = dealFolderArgs("9000000000002", {
    id: "9000000000002",
    Deal_Jacket_Folder_ID: "   ",
    Signed_Documents_Folder_ID: { not: "text" },
  });
  assert.deepEqual(args, { p_zoho_deal_id: "9000000000002", p_deal_jacket: null, p_supporting: null, p_signed: null });
  // A numeric ID is still an ID.
  assert.equal(dealFolderArgs("1", { Deal_Jacket_Folder_ID: 12345 }).p_deal_jacket, "12345");
  // The wrong case is not the field.
  assert.equal(dealFolderArgs("1", { deal_jacket_folder_id: "jacket-sample-2" }).p_deal_jacket, null);
});

test("zoho-sync records the folders after the deal mirrors and before the queue row is done", () => {
  const src = read(SYNC);
  const upsert = src.indexOf('await sbUpsert("deals"');
  const rpc = src.indexOf('await sbRpc<DealFolderOutcome>(\n          "record_deal_folders",');
  const done = src.indexOf("await markProcessed(ids);\n        synced++;");
  assert.ok(upsert > 0 && rpc > upsert && done > rpc, "upsert, then record_deal_folders, then processed");
  assert.match(src, /\{ \.\.\.dealFolderArgs\(head\.zoho_id, record\) \},\s*"fni",/);
  // Inside the item's try: a failure fails the item and the sweeper retries it.
  const tryAt = src.lastIndexOf("try {", rpc);
  const catchAt = src.indexOf("} catch (err) {", rpc);
  assert.ok(tryAt < rpc && catchAt > done);
});

test("filing starts only when the folders became ready, off the sync's own path", () => {
  const src = read(SYNC);
  assert.match(src, /if \(folders\?\.folders_became_ready\) await fileInBackground\(folders\.session_id, pending\);/);
  assert.match(src, /if \(typeof EdgeRuntime !== "undefined"\) EdgeRuntime\.waitUntil\(work\);\s*else pending\.push\(work\);/);
  // The filing never reaches the queue row's failure path.
  assert.match(src, /const work = fileWhenFoldersReady\(supabase, sessionId\)\.catch\(/);
});

test("a folder ID is never logged", () => {
  const log = dealFolderLog({
    session_id: "00000000-0000-4000-8000-000000000001",
    deal_jacket_outcome: "Set",
    signed_documents_outcome: "Unchanged",
    folders_became_ready: false,
  });
  assert.deepEqual(log, { deal_jacket: "Set", signed_documents: "Unchanged", folders_became_ready: false });
  const src = read(SYNC);
  assert.match(src, /if \(folders\) console\.log\(`zoho-sync \$\{head\.module\}\/\$\{head\.zoho_id\} deal folders`, dealFolderLog\(folders\)\);/);
  assert.doesNotMatch(src, /console\.\w+\([^)]*(Folder_ID|p_deal_jacket|p_signed|p_supporting)/);
});

test("sbRpc calls the function in the schema it names", () => {
  const sb = read("supabase/functions/_shared/supabase.ts");
  assert.match(sb, /`rpc\/\$\{fn\}`,\s*\{ method: "POST", headers: headers\(\{ "Content-Profile": schema \}\), body: JSON\.stringify\(args\) \},/);
});
