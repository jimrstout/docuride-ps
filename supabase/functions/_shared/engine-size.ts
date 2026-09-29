// _shared/engine-size.ts
//
// Engine size, resolved one way for the Verify sheet and the rate request both.
//
// ── The gap this closes ─────────────────────────────────────────────────
// The sheet read staff, then the VIN decode's displacement. The rate request
// read only what staff had typed into vehicle_properties, and never looked at
// the decode. So a decoded engine size filled the sheet, Verify let the deal
// through, and the rate was then refused for missing engine.ccs, or sent with
// no displacement at the top level: TecAssured's " Missing displacement." Both
// sides now call resolveEngineCc, so what the sheet shows is what is sent.
//
// ── No default ──────────────────────────────────────────────────────────
// Unlike fuel type, there is no fallback value. Engine size moves the price,
// and a guess would be a guess at somebody's price. With neither a staff value
// nor a decode it is Missing, and a rate is refused rather than invented.

/** Where a resolved engine size came from. The same words the sheet uses. */
export type EngineCcSource = "Entered by Staff" | "VIN Decode";

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function lookup(bag: unknown, names: string[]): unknown {
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return undefined;
  const wanted = names.map((n) => n.toLowerCase());
  for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
    if (wanted.includes(k.toLowerCase())) return v;
  }
  return undefined;
}

/**
 * Staff value, then the VIN decode's displacement. Null when neither says.
 *
 * Staff is read under either name the two request formats use, engine.ccs or
 * displacement, case-insensitively, as the rate request always has. The value
 * is passed through as stored, trimmed, so the sheet and the request carry the
 * same string.
 */
export function resolveEngineCc(
  vehicleProperties: unknown,
  vinDecode: unknown
): { value: string; source: EngineCcSource } | null {
  const staff = text(lookup(vehicleProperties, ["engine.ccs", "displacement"]));
  if (staff !== null) return { value: staff, source: "Entered by Staff" };

  const decoded = text(lookup(vinDecode, ["displacement"]));
  if (decoded !== null) return { value: decoded, source: "VIN Decode" };

  return null;
}
