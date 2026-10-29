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
//   4. The row records the WorkDrive file id, name and time and the Deal
//      Jacket folder, and its status becomes "Saved to Deal Jacket" (a voided
//      one stays "Voided").
//
// Before anything is touched, the row is claimed (filing_started_at,
// migration 0041), so two callers, such as zoho-sync's filing and a Get
// document, cannot file the same contract at once. The claim is cleared when
// the filing ends, however it ends; one older than FILE_CLAIM_STALE_MS is
// taken to be abandoned.
//
// A document already in the Deal Jacket is skipped, so this is safe to run
// any number of times. Only rows PS recorded are ever moved: the caller passes
// them in. The WorkDrive, bucket and database calls are passed in too, so a
// Node test can run the whole thing.

import { routedFileName, sameDocument, voidedBaseName } from "./document-names.ts";

export const WAITING = "Waiting for Deal Jacket";
export const SAVED = "Saved to Deal Jacket";
export const VOIDED = "Voided";

/** A filing claim older than this was abandoned and may be taken over. */
export const FILE_CLAIM_STALE_MS = 5 * 60 * 1000;

/** Said when another caller is filing the same contract right now. */
export const BEING_FILED = "Being filed to the Deal Jacket by another request. Nothing changed.";

/** PostgREST's or-filter for a row nobody is filing, or whose claim is stale. */
export function unclaimedFilingFilter(now: Date): string {
  const staleBefore = new Date(now.getTime() - FILE_CLAIM_STALE_MS).toISOString();
  return `filing_started_at.is.null,filing_started_at.lt.${staleBefore}`;
}

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
  /** Claim the row for this filing. False: another caller has it, or it is filed. */
  claim(rowId: string): Promise<boolean>;
  /** Give the claim back after a filing that did not finish. */
  release(rowId: string): Promise<void>;
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

export const ALREADY_FILED = "Already in the Deal Jacket. Nothing changed.";
export const NOTHING_HELD = "No document is held for this contract yet. Get its document first.";

/** Why a held document will not move, or null when it should. */
export function skipReason(doc: HeldDocument): string | null {
  if (doc.workdrive_file_id) return ALREADY_FILED;
  if (!doc.document_storage_path || !doc.document_name) return NOTHING_HELD;
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
    let claimed: boolean;
    try {
      claimed = await deps.claim(doc.id);
    } catch (err) {
      lines.push({ contract_number: doc.contract_number, file_name: name, outcome: deps.problem(err), moved: false });
      continue;
    }
    if (!claimed) {
      lines.push({ contract_number: doc.contract_number, file_name: name, outcome: BEING_FILED, moved: false });
      continue;
    }
    let recorded = false;
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
        deal_jacket_folder_id: folders.deal_jacket_folder_id,
        document_status: doc.document_status === VOIDED ? VOIDED : SAVED,
        // The claim ends with the record.
        filing_started_at: null,
      });
      recorded = true;
      lines.push({
        contract_number: doc.contract_number,
        file_name: name,
        outcome: doc.document_status === VOIDED ? "Saved to Deal Jacket, marked VOID." : "Saved to Deal Jacket.",
        moved: true,
      });
    } catch (err) {
      lines.push({ contract_number: doc.contract_number, file_name: name, outcome: deps.problem(err), moved: false });
    } finally {
      if (!recorded) await deps.release(doc.id).catch(() => {});
    }
  }
  return lines;
}

// ── What zoho-sync records about a filing it started ───────────────────────
// (_shared/deal-jacket-file.ts). Pure, so a Node test holds it.

export const FILED_EVENT = "Contracts filed to Deal Jacket when CRM created the deal's folders";
export const NOT_FILED_EVENT = "Contract not filed to Deal Jacket";
export const FILING_FAILED_EVENT = "Contracts not filed to Deal Jacket when CRM created the deal's folders";

/** A session event to write. */
export interface FilingEvent {
  event: string;
  detail: Record<string, unknown>;
}

/**
 * The session events for a filing zoho-sync started. A line skipped because
 * it was already filed, had nothing held, or was being filed by another
 * request at that moment is not a failure.
 */
export function filingEvents(lines: MoveLine[]): FilingEvent[] {
  const quiet = new Set([BEING_FILED, ALREADY_FILED, NOTHING_HELD]);
  const filed = lines.filter((l) => l.moved);
  const out: FilingEvent[] = [];
  if (filed.length > 0) {
    out.push({
      event: FILED_EVENT,
      detail: { count: filed.length, contract_numbers: filed.map((l) => l.contract_number) },
    });
  }
  for (const l of lines) {
    if (l.moved || quiet.has(l.outcome)) continue;
    out.push({ event: NOT_FILED_EVENT, detail: { contract_number: l.contract_number, reason: l.outcome } });
  }
  return out;
}
