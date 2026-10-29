// _shared/deal-jacket-request.ts
//
// What a call to fni-documents-to-deal-jacket asks for, and which folders it
// gets. Pure, so a Node test holds the rules.
//
// The deal is named by its Zoho DocuRide record id, or its deal number (Verify's
// own button sends the session id). Folder ids are taken one by one: sent with
// the call first, then the deal's session (which zoho-sync fills from the CRM,
// migration 0041), then dc.deals as a read-only fallback.

import { readyFolders } from "./contract-documents.ts";

export interface MoveRequest {
  record_id: string | null;
  deal_number: string | null;
  session_id: string | null;
  deal_jacket_folder_id: string | null;
  signed_documents_folder_id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_ID = /^\d{10,25}$/;
const FOLDER_ID = /^[A-Za-z0-9]{10,60}$/;

const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");

/** The request, checked. Every refusal is a sentence. */
export function parseMoveRequest(body: Record<string, unknown>): { request: MoveRequest } | { error: string } {
  const record = text(body.record_id ?? body.zoho_id ?? body.zoho_record_id);
  const deal = text(body.deal_number);
  const session = text(body.session_id);
  const jacket = text(body.deal_jacket_folder_id);
  const signed = text(body.signed_documents_folder_id);

  if (record === "" && deal === "" && session === "") {
    return { error: "Say which deal: send record_id (the Zoho DocuRide record id) or deal_number." };
  }
  if (record !== "" && !RECORD_ID.test(record)) return { error: "record_id is not a Zoho record id." };
  if (session !== "" && !UUID.test(session)) return { error: "session_id is not a DocuRide session." };
  if (deal.length > 30) return { error: "deal_number is longer than a deal number can be." };
  for (const [name, v] of [["deal_jacket_folder_id", jacket], ["signed_documents_folder_id", signed]] as const) {
    if (v !== "" && !FOLDER_ID.test(v)) return { error: `${name} is not a WorkDrive folder id.` };
  }
  return {
    request: {
      record_id: record || null,
      deal_number: deal || null,
      session_id: session || null,
      deal_jacket_folder_id: jacket || null,
      signed_documents_folder_id: signed || null,
    },
  };
}

/** Where the folder ids came from: "This call", "The session", "DocuRide DC", or two joined by "and". */
export type FolderSource = string;

type FolderPair = { deal_jacket_folder_id: string | null; signed_documents_folder_id: string | null };

const has = (v: string | null | undefined): v is string => typeof v === "string" && v.trim() !== "";

/**
 * The folders to move into: each id from the call if it sent one, otherwise
 * from the deal's session, otherwise from dc.deals. Null when either is still
 * unknown, which is "Missing Folder".
 */
export function resolveFolders(
  request: Pick<MoveRequest, "deal_jacket_folder_id" | "signed_documents_folder_id">,
  dc: FolderPair | null,
  session: FolderPair | null = null
): { folders: { deal_jacket_folder_id: string; signed_documents_folder_id: string }; source: FolderSource } | null {
  const pick = (key: keyof FolderPair): { id: string | null; from: string | null } =>
    has(request[key]) ? { id: request[key], from: "This call" }
    : has(session?.[key]) ? { id: session![key], from: "The session" }
    : has(dc?.[key]) ? { id: dc![key], from: "DocuRide DC" }
    : { id: null, from: null };
  const jacket = pick("deal_jacket_folder_id");
  const signed = pick("signed_documents_folder_id");
  const folders = readyFolders({ deal_jacket_folder_id: jacket.id, signed_documents_folder_id: signed.id });
  if (!folders) return null;
  const from = [...new Set([jacket.from!, signed.from!])];
  const source = from.length === 1 ? from[0] : `${from[0]} and ${from[1].replace(/^The /, "the ")}`;
  return { folders, source };
}

/** Said when the deal's folders are not known yet. Nothing is changed. */
export const MISSING_FOLDER_MESSAGE =
  "Missing Folder. This deal has no Deal Jacket or Signed Documents folder yet, in this call, on its session or in DocuRide DC. " +
  "Nothing was moved or changed. Call again once DocuRide DC has made the deal's folders.";
