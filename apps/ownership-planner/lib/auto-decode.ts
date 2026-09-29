// lib/auto-decode.ts: when the Verify page decodes the VIN on its own.
//
// The first time Verify opens for a session with a VIN, the page asks
// fni-vin-decode once, server side, so engine size and fuel type are usually
// filled before anybody looks. It never blocks the page: the call is given
// AUTO_DECODE_TIMEOUT_MS, and any failure or timeout is logged and the sheet is
// shown anyway.
//
// "Once" is decided by the session, not the page. fni-vin-decode records the
// attempt (vin_decode_attempted_at) before it calls TecAssured, so while
// TecAssured is down a session costs one try, not one per page load. The Decode
// the VIN button is the manual retry. Migration 0017.
//
// No Next imports here, so the rule can be tested directly. The same split as
// verify-flash.ts.

/** How long the page waits for the automatic decode before showing the sheet. */
export const AUTO_DECODE_TIMEOUT_MS = 5000;

interface DecodeState {
  fields: { key: string; value: string | null }[];
  vin_decode_at: string | null;
  vin_decode_attempted_at?: string | null;
}

function hasVin(sheet: DecodeState): boolean {
  const vin = sheet.fields.find((f) => f.key === "vin")?.value;
  return typeof vin === "string" && vin.trim() !== "";
}

/** A VIN, never decoded, never tried. Only then does the page try on its own. */
export function shouldAutoDecode(sheet: DecodeState): boolean {
  return (
    hasVin(sheet) &&
    !sheet.vin_decode_at &&
    !sheet.vin_decode_attempted_at
  );
}

/** Tried and not decoded: the page says so next to the Decode the VIN button. */
export function decodeDidNotAnswer(sheet: DecodeState): boolean {
  return !sheet.vin_decode_at && !!sheet.vin_decode_attempted_at;
}
