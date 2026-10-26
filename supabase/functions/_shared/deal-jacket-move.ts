// _shared/deal-jacket-move.ts
//
// Moving held contract documents into a deal's WorkDrive Deal Jacket.
//
// Every contract PDF PS fetches is held in the private fni-contracts bucket
// first. Once the deal has a Deal Jacket and a Signed Documents folder, each
// held document that is not in the Deal Jacket yet is moved there:
//
//   1. Its full name is built: the stored name, plus the routing part with the
//      Signed Documents folder id (_shared/document-names.ts). A voided
//      document's name ends " VOID", so it lands with " VOID" before the
//      first pipe.
//   2. A file in the Deal Jacket with that name goes to the WorkDrive trash,
//      as DocuRide DC replaces its own documents.
//   3. The PDF is uploaded from the bucket. The bucket copy is kept.
//   4. The row records the WorkDrive file id, name and time, and its status
//      becomes "Saved to Deal Jacket" (a voided one stays "Voided").
//
// A document already in the Deal Jacket is skipped, so this is safe to run
// any number of times. Only rows PS recorded are ever moved: the caller passes
// them in. The WorkDrive, bucket and database calls are passed in too, so a
// Node test can run the whole thing.

import { routedFileName, sameDocument, voidedBaseName } from "./document-names.ts";

export const WAITING = "Waiting for Deal Jacket";
export const SAVED = "Saved to Deal Jacket";
export const VOIDED = "Voided";

/** What a held document's row carries. */
export interface HeldDocument {
  id: string;
  contract_number: string | null;
  document_name: string | null;
  document_storage_path: string | null;
  document_status: string | null;
  workdrive_file_id: string | null;
}

export interface JacketFolders {
  deal_jacket_folder_id: string;
  signed_documents_folder_id: string;
}

export interface MoveDeps {
  /** The held PDF, or null if the bucket does not have it. */
  download(path: string): Promise<Uint8Array | null>;
  listJacket(folderId: string): Promise<{ id: string; name: string }[]>;
  trash(fileId: string): Promise<void>;
  /** Returns the new WorkDrive file id. */
  upload(folderId: string, name: string, bytes: Uint8Array): Promise<string>;
  record(rowId: string, fields: Record<string, unknown>): Promise<void>;
  now(): string;
  /** A refusal from WorkDrive, in plain English. */
  problem(err: unknown): string;
}

/** One line of the answer: the file and what happened to it. */
export interface MoveLine {
  contract_number: string | null;
  file_name: string | null;
  outcome: string;
  /** True when this call put it in the Deal Jacket. */
  moved: boolean;
}

/** The file name a held document gets in the Deal Jacket. */
export function jacketName(doc: HeldDocument, folders: JacketFolders): string | null {
  if (!doc.document_name) return null;
  const base = doc.document_status === VOIDED ? voidedBaseName(doc.document_name) : doc.document_name;
  return routedFileName(base, folders.signed_documents_folder_id);
}

/** Why a held document will not move, or null when it should. */
export function skipReason(doc: HeldDocument): string | null {
  if (doc.workdrive_file_id) return "Already in the Deal Jacket. Nothing changed.";
  if (!doc.document_storage_path || !doc.document_name) return "No document is held for this contract yet. Get its document first.";
  return null;
}

export async function moveHeldDocuments(
  docs: HeldDocument[],
  folders: JacketFolders,
  deps: MoveDeps
): Promise<MoveLine[]> {
  const lines: MoveLine[] = [];
  let items: { id: string; name: string }[] | null = null;

  for (const doc of docs) {
    const name = jacketName(doc, folders);
    const skip = skipReason(doc);
    if (skip) {
      lines.push({ contract_number: doc.contract_number, file_name: name, outcome: skip, moved: false });
      continue;
    }
    try {
      const bytes = await deps.download(doc.document_storage_path!);
      if (!bytes) {
        lines.push({
          contract_number: doc.contract_number,
          file_name: name,
          outcome: "The held PDF could not be found in the bucket. Get its document again.",
          moved: false,
        });
        continue;
      }
      items ??= await deps.listJacket(folders.deal_jacket_folder_id);
      for (const f of items.filter((f) => sameDocument(f.name, name!))) await deps.trash(f.id);
      const fileId = await deps.upload(folders.deal_jacket_folder_id, name!, bytes);
      items = items.filter((f) => !sameDocument(f.name, name!)).concat([{ id: fileId, name: name! }]);

      await deps.record(doc.id, {
        workdrive_file_id: fileId,
        workdrive_file_name: name,
        workdrive_saved_at: deps.now(),
        filename: name,
        document_status: doc.document_status === VOIDED ? VOIDED : SAVED,
      });
      lines.push({
        contract_number: doc.contract_number,
        file_name: name,
        outcome: doc.document_status === VOIDED ? "Saved to Deal Jacket, marked VOID." : "Saved to Deal Jacket.",
        moved: true,
      });
    } catch (err) {
      lines.push({ contract_number: doc.contract_number, file_name: name, outcome: deps.problem(err), moved: false });
    }
  }
  return lines;
}
