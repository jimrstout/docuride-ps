// _shared/deal-folders.ts
//
// A deal's three WorkDrive folder IDs, as the CRM sends them, handed to
// fni.record_deal_folders (migration 0041).
//
// The CRM Flow "Generate Contract Documents" writes Deal_Jacket_Folder_ID,
// Supporting_Documents_Folder_ID and Signed_Documents_Folder_ID to the
// DocuRide record, and that edit fires zoho-sync. zoho-sync passes the three
// on as they are, blank or not, on every sync: record_deal_folders keeps the
// first value of each, never lets a blank clear one, logs a blank or a
// different value once, and says whether the Deal Jacket and Signed
// Documents folders both became known with this write.
//
// Field API names checked against the DocuRide module's field metadata on
// 29 Oct 2026 (all three are text fields).
//
// A folder ID is never logged or written into a session event.
//
// Pure, so a Node test can hold it.

export const DEAL_JACKET_FIELD = "Deal_Jacket_Folder_ID";
export const SUPPORTING_DOCUMENTS_FIELD = "Supporting_Documents_Folder_ID";
export const SIGNED_DOCUMENTS_FIELD = "Signed_Documents_Folder_ID";

/** The arguments of fni.record_deal_folders, by its parameter names. */
export interface DealFolderArgs {
  p_zoho_deal_id: string;
  p_deal_jacket: string | null;
  p_supporting: string | null;
  p_signed: string | null;
}

/** What fni.record_deal_folders answers. No row: the deal has no session. */
export interface DealFolderOutcome {
  session_id: string;
  deal_jacket_outcome: "Set" | "Blank from CRM" | "Changed" | "Unchanged";
  signed_documents_outcome: "Set" | "Blank from CRM" | "Changed" | "Unchanged";
  folders_became_ready: boolean;
}

/** A text field as the CRM sent it, trimmed; null when blank or not text. */
function folderId(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

/** The deal's folder IDs from its CRM record, for fni.record_deal_folders. */
export function dealFolderArgs(zohoDealId: string, record: Record<string, unknown>): DealFolderArgs {
  return {
    p_zoho_deal_id: zohoDealId.trim(),
    p_deal_jacket: folderId(record[DEAL_JACKET_FIELD]),
    p_supporting: folderId(record[SUPPORTING_DOCUMENTS_FIELD]),
    p_signed: folderId(record[SIGNED_DOCUMENTS_FIELD]),
  };
}

/** What happened, for the log: outcomes only, never a folder ID. */
export function dealFolderLog(o: DealFolderOutcome): Record<string, unknown> {
  return {
    deal_jacket: o.deal_jacket_outcome,
    signed_documents: o.signed_documents_outcome,
    folders_became_ready: o.folders_became_ready,
  };
}
