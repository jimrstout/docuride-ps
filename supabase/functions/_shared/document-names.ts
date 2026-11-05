// _shared/document-names.ts
//
// What a provider's contract document is called in the deal's WorkDrive Deal
// Jacket. One function, so every place that saves, finds or renames one agrees.
//
//   {prefix}{nn} MUI #{deal number} {buyer display name} {product name} {contract number}|SignedDocuRideDC|{signed documents folder id}|
//
// then ".pdf", as WorkDrive shows DocuRide DC's own stored documents, so ours
// sit alongside them. {nn} is the contract's two-digit place on the deal (01,
// 02...), in submit order, kept once given.
//
// The character cleanup is DocuRide DC's (cleanName in its _shared/dc-folders.ts,
// used by documentFileName in _shared/dc-forms.ts): \ / : * ? " < > become "-",
// double spaces collapse, and the pipes stay. Copied rather than imported,
// because the two apps deploy separately; a test pins the copy to the original.
//
// A voided contract's file keeps its place and its name, with "|VOID|" put in
// front of it (5 Nov 2026), so it can never be mistaken for a live contract.
// Zoho Flow recognises voided contracts by that marker at the very front: it
// moves them out of the Deal Jacket with the rest and leaves them out of the
// signing session. Before, " VOID" went before the first pipe; a name marked
// that way is already voided and is never marked again or renamed.

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

/** DocuRide DC's cleanup: \ / : * ? " < > become "-", double spaces collapse. */
export function cleanName(name: string): string {
  return name.replace(/[\\/:*?"<>]/g, "-").replace(/ {2,}/g, " ");
}

export interface ContractDocumentParts {
  /** The provider's document prefix, as in "TA". */
  prefix: string;
  /** The contract's place on the deal, from 1. */
  position: number;
  deal_number: string;
  buyer_display_name: string;
  product_name: string;
  contract_number: string;
  signed_documents_folder_id: string;
}

/** Two digits from 1 to 99: 1 is "01". */
export function positionCode(position: number): string {
  if (!Number.isInteger(position) || position < 1 || position > 99) {
    throw new Error(`A contract's place on a deal is 1 to 99, not ${position}.`);
  }
  return String(position).padStart(2, "0");
}

/**
 * The name without its routing part:
 *   TA01 MUI #13759 {buyer} {product} {contract}
 * Known as soon as the document is fetched, so it is what is stored while a
 * document waits for its Deal Jacket. The routing part needs the Signed
 * Documents folder id, which may not exist yet.
 */
export function documentBaseName(p: Omit<ContractDocumentParts, "signed_documents_folder_id">): string {
  return cleanName(
    `${str(p.prefix)}${positionCode(p.position)} MUI #${str(p.deal_number)} ${str(p.buyer_display_name)} ` +
      `${str(p.product_name)} ${str(p.contract_number)}`
  );
}

/** The full WorkDrive file name from a stored base name and the Signed Documents folder id. */
export function routedFileName(baseName: string, signedDocumentsFolderId: string): string {
  return `${cleanName(`${baseName}|SignedDocuRideDC|${str(signedDocumentsFolderId)}|`)}.pdf`;
}

/** The name before ".pdf". The closing pipe is part of it, as in DocuRide DC. */
export function contractDocumentName(p: ContractDocumentParts): string {
  return routedFileName(documentBaseName(p), p.signed_documents_folder_id).slice(0, -4);
}

/** The file's name in WorkDrive. */
export function contractFileName(p: ContractDocumentParts): string {
  return routedFileName(documentBaseName(p), p.signed_documents_folder_id);
}

/** The marker a voided contract's file name starts with. */
export const VOID_MARKER = "|VOID|";

/** The old marker: " VOID" before the first pipe (or on the end of a base name). */
const OLD_VOID = " VOID";

/**
 * A voided base name, as stored while a document waits for its Deal Jacket:
 * "|VOID|" and the base name exactly as it was. Once only. A base name voided
 * the old way (" VOID" on the end) has not been filed yet, so it takes the new
 * marker in place of the old one: "|VOID|" and the name it had before.
 */
export function voidedBaseName(baseName: string): string {
  if (baseName.startsWith(VOID_MARKER)) return baseName;
  const original = baseName.endsWith(OLD_VOID) ? baseName.slice(0, -OLD_VOID.length) : baseName;
  return `${VOID_MARKER}${original}`;
}

/**
 * The PDF's name in the private fni-contracts bucket. Supabase Storage keys
 * take letters, digits, spaces and a few marks only, so anything else ("#",
 * accented letters) becomes "-" there. The WorkDrive name keeps them.
 */
export function storageFileName(baseName: string): string {
  return `${baseName.replace(/[^A-Za-z0-9 _!.*'()&$@=;:+,-]/g, "-").replace(/ {2,}/g, " ").trim()}.pdf`;
}

/** A file in the folder that is this document: the name itself, or with ".pdf". */
export function sameDocument(itemName: string, name: string): boolean {
  const base = name.endsWith(".pdf") ? name.slice(0, -4) : name;
  return itemName === base || itemName === `${base}.pdf`;
}

/**
 * A filed file's voided name: "|VOID|" and its name exactly as it was. A name
 * already voided, either way, stays as it is: the marker is never put on
 * twice, and a file voided the old way is not renamed.
 */
export function voidedName(name: string): string {
  if (isVoidedName(name)) return name;
  return `${VOID_MARKER}${name}`;
}

/** Already marked void: "|VOID|" in front, or the old " VOID" before the first pipe. */
export function isVoidedName(name: string): boolean {
  if (name.startsWith(VOID_MARKER)) return true;
  const at = name.indexOf("|");
  const head = at < 0 ? name.replace(/\.pdf$/, "") : name.slice(0, at);
  return head.endsWith(OLD_VOID);
}
