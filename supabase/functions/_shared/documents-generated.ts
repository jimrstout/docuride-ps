// _shared/documents-generated.ts
//
// The CRM's call each time a deal's documents are generated
// (fni-documents-generated). Pure, so a Node test can hold the rules.
//
// A first Generate makes the folders: the session has no Deal Jacket yet, and
// zoho-sync files the contracts when the Flow writes the folder IDs. A
// regenerate (after an error, or a change of mind) rewrites the same folder
// IDs, so zoho-sync sees nothing new; and signing may have moved the earlier
// contract files out of the Deal Jacket. So on a regenerate PS files every
// contract document again, the way the Flow treats its own: a file already
// there by name is replaced, one missing is added, nothing else is touched.

export interface GeneratedRequest {
  zoho_deal_id: string;
  initiated_by: string | null;
}

const RECORD_ID = /^\d{10,25}$/;

/** The request, checked. A refusal is a sentence. */
export function parseGenerated(body: unknown): { request: GeneratedRequest } | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const id = typeof b.zoho_deal_id === "string" || typeof b.zoho_deal_id === "number" ? String(b.zoho_deal_id).trim() : "";
  if (id === "") return { error: "zoho_deal_id is required: the CRM DocuRide record id." };
  if (!RECORD_ID.test(id)) return { error: "zoho_deal_id is not a CRM record id." };
  const by = typeof b.initiated_by === "string" ? b.initiated_by.trim() : "";
  return { request: { zoho_deal_id: id, initiated_by: by === "" ? null : by.slice(0, 120) } };
}

/**
 * Who pressed Generate, as initials for the session event: "Jim Stout" and
 * "jim.stout@example.com" are "JS", "js" is "JS". Nobody, or nothing usable,
 * is "System".
 */
export function initialsOf(v: string | null): string {
  if (!v) return "System";
  const s = v.trim();
  if (/^[A-Za-z0-9]{1,4}$/.test(s)) return s.toUpperCase();
  const words = (s.includes("@") ? s.split("@")[0] : s).split(/[\s._\-+]+/).filter((w) => /[a-z]/i.test(w));
  const letters = words.length >= 2 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? "").slice(0, 2);
  return letters ? letters.toUpperCase() : "System";
}

export interface GeneratedReply {
  session_found: boolean;
  folders_known: boolean;
  contracts_queued: number;
  message: string;
}

export const NO_SESSION = "No F&I session for this deal, nothing to file.";
export const NO_FOLDERS = "Folders not created yet.";

export function queuedMessage(n: number): string {
  return n === 0
    ? "Documents regenerated. This deal has no contract documents to file."
    : `Documents regenerated. ${n} contract ${n === 1 ? "document is" : "documents are"} being filed to the Deal Jacket.`;
}
