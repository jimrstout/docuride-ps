// _shared/fuel-type.ts
//
// Fuel type, resolved one way for the Verify sheet and the rate request both.
//
// ── Why its own module ──────────────────────────────────────────────────
// The sheet and the rate request used to answer this separately. The sheet read
// staff, then the VIN decode, and showed Missing otherwise. The request read
// staff, then fell back to "Gas", and never looked at the decode at all. So a
// decoded diesel showed Diesel on the screen and went to TecAssured as G, and
// the properties array could carry the word "Gas" while the top-level fuelType
// beside it carried "G". Both now call resolveFuelType, so they cannot disagree.
//
// ── Words stored, codes sent ────────────────────────────────────────────
// What is stored and shown is a word: Gasoline, Electric, Diesel. TecAssured's
// codes (section 6.5: G, E, D) are produced only when a rate request is built,
// by fuelCodeFor, and go into BOTH the top-level fuelType and the fuel.type
// entry in the properties array. Older sessions hold codes (G, E, D) or "Gas";
// fuelWord reads those as the words they stand for.
//
// ── Why a default at all ────────────────────────────────────────────────
// No Zoho field carries fuel type, and every unit in this dealer group's deal
// history is gasoline. It is an eligibility input rather than a price input,
// and refusing to rate every deal over a field nobody could fill in was the
// alternative. The default is shown as "Default" on the sheet, so it reads as
// not checked rather than as a fact somebody confirmed.

export const FUEL_TYPES = ["Gasoline", "Electric", "Diesel"] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const DEFAULT_FUEL_TYPE: FuelType = "Gasoline";

/** Where a resolved fuel type came from. The same words the sheet uses. */
export type FuelSource = "Entered by Staff" | "VIN Decode" | "Default";

/** Every spelling we have stored or been sent, read as the word it means. */
const WORDS: Record<string, FuelType> = {
  g: "Gasoline", gas: "Gasoline", gasoline: "Gasoline", petrol: "Gasoline",
  e: "Electric", electric: "Electric", ev: "Electric",
  d: "Diesel", diesel: "Diesel",
};

/** Section 6.5. The only values TecAssured documents. */
const CODES: Record<FuelType, "G" | "E" | "D"> = {
  Gasoline: "G",
  Electric: "E",
  Diesel: "D",
};

/** Any stored value or code, as a word. Null when it is not a fuel type. */
export function fuelWord(v: unknown): FuelType | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  return s === "" ? null : WORDS[s] ?? null;
}

/**
 * A value a person chose, accepted only if it is one of the three words.
 *
 * Stricter than fuelWord on purpose: a new edit is stored as the word, so the
 * store holds words from here on. Codes are still READ, never written.
 */
export function fuelChoice(v: unknown): FuelType | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return FUEL_TYPES.find((w) => w.toLowerCase() === s) ?? null;
}

/** The TecAssured code for a word. Only the rate request calls this. */
export function fuelCodeFor(word: FuelType): "G" | "E" | "D" {
  return CODES[word];
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
 * Staff choice, then the VIN decode, then Gasoline.
 *
 * A stored value that is not a fuel type is passed over rather than trusted,
 * so it can never reach the request as something TecAssured does not accept.
 * The save path refuses such a value before it is stored, so this only matters
 * for rows written before that rule existed.
 */
export function resolveFuelType(
  vehicleProperties: unknown,
  vinDecode: unknown
): { value: FuelType; source: FuelSource } {
  const staff = fuelWord(lookup(vehicleProperties, ["fuel.type", "fueltype"]));
  if (staff !== null) return { value: staff, source: "Entered by Staff" };

  const decoded = fuelWord(lookup(vinDecode, ["fuelType"]));
  if (decoded !== null) return { value: decoded, source: "VIN Decode" };

  return { value: DEFAULT_FUEL_TYPE, source: "Default" };
}
