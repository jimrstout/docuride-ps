// _shared/contract-documents.ts
//
// The checks that come before a provider's contract document is saved to the
// deal's WorkDrive Deal Jacket, each a plain-English sentence. Pure, so a Node
// test holds them. fni-contract-documents runs them before it asks the
// provider for anything, so a refusal saves nothing.

/** The private bucket provider contract PDFs are held in. Never public. */
export const HOLD_BUCKET = "fni-contracts";

/** The word DocuRide DC uses when a deal's folders are not there. */
export const MISSING_FOLDER = "Missing Folder";

export interface DealFolders {
  deal_number: string | null;
  buyer_display_name: string | null;
  deal_jacket_folder_id: string | null;
  signed_documents_folder_id: string | null;
}

const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === "";

/** Why the deal cannot take documents yet, or null. Same rule as DocuRide DC. */
export function folderProblem(deal: DealFolders | null): string | null {
  if (!deal) {
    return (
      "This deal is not in DocuRide DC yet, so it has no Deal Jacket. Generate its documents in DocuRide DC " +
      "once (V2 Generate Documents), which makes its WorkDrive folders, then try again."
    );
  }
  if (blank(deal.deal_jacket_folder_id) || blank(deal.signed_documents_folder_id)) {
    return (
      "This deal has no Deal Jacket or Signed Documents folder in WorkDrive yet. Generate its documents in " +
      "DocuRide DC once (V2 Generate Documents), which makes them, then try again."
    );
  }
  if (blank(deal.buyer_display_name)) {
    return "This deal has no buyer name in DocuRide DC, and its documents are named after the buyer.";
  }
  return null;
}

/** Why this provider cannot send documents to WorkDrive, or null. */
export function prefixProblem(provider: { name: string; document_prefix: string | null } | null): string | null {
  if (!provider) return "This contract's provider could not be found, so nothing was saved.";
  if (blank(provider.document_prefix)) {
    return (
      `${provider.name} has no document prefix, so its documents cannot be sent to WorkDrive. ` +
      `Set one in Admin > Providers, then try again.`
    );
  }
  return null;
}

/**
 * Places for contracts that have none yet, after the highest already given.
 * A contract submitted before places existed gets the next one, in the order
 * it was recorded.
 */
export function assignPositions<T extends { id: string; document_position: number | null; created_at?: string }>(
  rows: T[]
): Map<string, number> {
  const out = new Map<string, number>();
  let next = Math.max(0, ...rows.map((r) => r.document_position ?? 0)) + 1;
  const missing = rows
    .filter((r) => r.document_position === null)
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  for (const r of rows) if (r.document_position !== null) out.set(r.id, r.document_position);
  for (const r of missing) out.set(r.id, next++);
  return out;
}

/** The folders, when the deal has both a Deal Jacket and a Signed Documents folder. */
export function readyFolders(
  deal: Pick<DealFolders, "deal_jacket_folder_id" | "signed_documents_folder_id"> | null
): { deal_jacket_folder_id: string; signed_documents_folder_id: string } | null {
  if (!deal || blank(deal.deal_jacket_folder_id) || blank(deal.signed_documents_folder_id)) return null;
  return {
    deal_jacket_folder_id: String(deal.deal_jacket_folder_id).trim(),
    signed_documents_folder_id: String(deal.signed_documents_folder_id).trim(),
  };
}

/**
 * The buyer's name for the file: DocuRide DC's, which its own documents use,
 * or the session's when the deal is not in DC yet. Null when neither has one.
 */
export function buyerNameFor(deal: Pick<DealFolders, "buyer_display_name"> | null, sessionBuyer: string | null): string | null {
  const dc = deal?.buyer_display_name;
  if (!blank(dc)) return String(dc).trim();
  if (!blank(sessionBuyer)) return String(sessionBuyer).trim();
  return null;
}

// ── Signature data, exactly as TecAssured returns it ─────────────────────
//
// /contract/document answers with `signatures`, an array of buyer and seller
// blocks (TECASSURED_SHOP_API.md). It is stored as it comes, whatever shape it
// takes next: an array, an object, a singular `signature`, or a new type such
// as "cobuyer". A type other than buyer and seller is reported, because it is
// what the co-buyer field probe (_shared/cobuyer-probe.ts) is looking for.

/** The signature data in a /contract/document answer, untouched. */
export function signatureData(doc: Record<string, unknown>): unknown {
  return doc.signatures ?? doc.signature ?? null;
}

const KNOWN_SIGNATURE_TYPES = new Set(["buyer", "seller"]);

/**
 * Every signature type other than buyer and seller, wherever it appears: a
 * `type` on a block, or a key of an object keyed by type. In the order found,
 * each once, as TecAssured spelled it.
 */
export function otherSignatureTypes(signatures: unknown): string[] {
  const found: string[] = [];
  const note = (t: unknown) => {
    if (typeof t !== "string" || t.trim() === "") return;
    if (!KNOWN_SIGNATURE_TYPES.has(t.trim().toLowerCase()) && !found.includes(t)) found.push(t);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if ("type" in o) note(o.type);
    else for (const [k, inner] of Object.entries(o)) if (inner && typeof inner === "object") note(k);
    for (const inner of Object.values(o)) if (inner && typeof inner === "object") walk(inner, depth + 1);
  };
  walk(signatures, 0);
  return found;
}
