// _shared/signature-map.ts
//
// FNI_Signature_Map is how the acknowledgment joins the existing signing
// pipeline. fni-contract-documents already builds this string, one line per
// contract, and the Zoho Flow Deluge function reads the field directly to place
// signature fields in the Zoho Sign request. The acknowledgment slots into that
// same mechanism -- one Zoho Sign packet, one buyer session, no new plumbing.
//
//   filename|page|left|top|right|bottom|signer_type
//
// Nothing here changes how the Deluge function reads the field.

/** FNI_Signature_Map is a Zoho textarea with a hard character limit. */
export const SIGNATURE_MAP_LIMIT = 2000;

export interface SignatureRect {
  filename: string;
  /** 1-based, as the existing lines are. */
  page: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  signerType?: string;
}

export function signatureLine(r: SignatureRect): string {
  return [
    r.filename,
    r.page,
    Math.round(r.left),
    Math.round(r.top),
    Math.round(r.right),
    Math.round(r.bottom),
    r.signerType ?? "buyer",
  ].join("|");
}

/**
 * pdf-lib draws from the bottom-left; signature placement is conventionally
 * expressed from the top-left. This is the only place that flip happens.
 *
 * UNCONFIRMED: TecAssured's own /contract/document coordinates have not been
 * seen yet, and the Deluge function parses both sources identically. If theirs
 * turn out to be bottom-left, this function is the one thing that changes.
 */
export function toTopLeft(
  pageHeight: number,
  bottomLeftY: number,
  height: number
): { top: number; bottom: number } {
  return {
    top: pageHeight - (bottomLeftY + height),
    bottom: pageHeight - bottomLeftY,
  };
}

export interface AppendResult {
  value: string;
  ok: boolean;
  reason?: string;
}

/**
 * Append one line to an existing map value.
 *
 * Refuses rather than truncating. A truncated map silently misplaces a
 * signature field on a document somebody then signs, which is far worse than a
 * failed append that a person can see and fix.
 */
export function appendSignatureMap(
  existing: string | null | undefined,
  line: string
): AppendResult {
  const base = (existing ?? "").replace(/\s+$/, "");

  // Appending a line that is already there would place two signature fields on
  // top of each other -- which is what a retried run would otherwise do.
  if (base.split("\n").some((l) => l.trim() === line.trim())) {
    return { value: base, ok: true, reason: "Line already present; nothing appended" };
  }

  const next = base === "" ? line : `${base}\n${line}`;
  if (next.length > SIGNATURE_MAP_LIMIT) {
    return {
      value: base,
      ok: false,
      reason:
        `Appending would make FNI_Signature_Map ${next.length} characters, ` +
        `over the ${SIGNATURE_MAP_LIMIT} limit`,
    };
  }
  return { value: next, ok: true };
}
