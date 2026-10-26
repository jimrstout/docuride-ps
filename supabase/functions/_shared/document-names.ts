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
// A voided contract's file keeps its place and gets " VOID" before the first
// pipe, so it can never be mistaken for a live contract.

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

/** The name before ".pdf". The closing pipe is part of it, as in DocuRide DC. */
export function contractDocumentName(p: ContractDocumentParts): string {
  return cleanName(
    `${str(p.prefix)}${positionCode(p.position)} MUI #${str(p.deal_number)} ${str(p.buyer_display_name)} ` +
      `${str(p.product_name)} ${str(p.contract_number)}|SignedDocuRideDC|${str(p.signed_documents_folder_id)}|`
  );
}

/** The file's name in WorkDrive. */
export function contractFileName(p: ContractDocumentParts): string {
  return `${contractDocumentName(p)}.pdf`;
}

/** A file in the folder that is this document: the name itself, or with ".pdf". */
export function sameDocument(itemName: string, name: string): boolean {
  const base = name.endsWith(".pdf") ? name.slice(0, -4) : name;
  return itemName === base || itemName === `${base}.pdf`;
}

/** The voided name: " VOID" before the first pipe. Already voided stays as it is. */
export function voidedName(name: string): string {
  const at = name.indexOf("|");
  const head = at < 0 ? name : name.slice(0, at);
  const tail = at < 0 ? "" : name.slice(at);
  return head.endsWith(" VOID") ? name : `${head} VOID${tail}`;
}
