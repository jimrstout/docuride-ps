// _shared/cobuyer-probe.ts
//
// TEMPORARY. The co-buyer field probe: finding out whether TecAssured takes a
// co-buyer on a contract, and under what name.
//
// TecAssured's Shop API documents only buyerFirstName, buyerLastName and
// buyerAddress. Another front end (iTap) gets co-buyers printed on contracts
// through the same TecAssured back end, so an undocumented field may exist. We
// send many guessed field names in one test submit, each carrying its own
// marker code, and read the contract: the code that prints names the field
// that worked. If none prints, TecAssured most likely holds no co-buyer at all
// and iTap stamps it on the PDF itself.
//
// Markers only. Nothing here ever carries a real name or any CRM data. No
// "buyers" or "customers" array is sent, because one could overwrite the real
// buyer.
//
// Used only by fni-contract-submit, only on a test session on the QA server,
// only for products whose form prints a co-buyer name row (PROBE_PRODUCTS).
// Delete this file, and the flag that reaches it, once the answer is in
// (docs/multi-provider.md, section 16).
//
// ── Round 2: the phone field (2026-10-28) ────────────────────────────────
// Round 1 answered the co-buyer: only CB03 printed, so cobuyerFirstName and
// cobuyerLastName on the quote fill the co-buyer name boxes, and TecAssured
// ignored every other key. The one blank left on the contract is the buyer's
// phone. Round 2 sends twenty guessed phone keys on the quote, each a
// fictional 304-555-01xx number whose last two digits name the guess (P01 is
// ...0101), digits only, and CB03 again to confirm round 1 repeats. Nothing
// goes at the top level, and never a buyers or customers array.

/** Where a variant's keys go: the quote (beside buyerFirstName) or the top level. */
export type ProbeLevel = "Quote" | "Top level";

export interface ProbeVariant {
  marker: string;
  level: ProbeLevel;
  /** First and last name keys, one key holding both, or an object holding both. */
  shape:
    | { kind: "Pair"; first: string; last: string }
    | { kind: "Full name"; key: string }
    | { kind: "Object"; key: string; first: string; last: string }
    | { kind: "Value"; key: string; value: string };
}

const pair = (marker: string, first: string, last: string, level: ProbeLevel = "Quote"): ProbeVariant => ({
  marker,
  level,
  shape: { kind: "Pair", first, last },
});
const full = (marker: string, key: string): ProbeVariant => ({ marker, level: "Quote", shape: { kind: "Full name", key } });
const obj = (marker: string, key: string, first: string, last: string, level: ProbeLevel = "Quote"): ProbeVariant => ({
  marker,
  level,
  shape: { kind: "Object", key, first, last },
});

const phone = (marker: string, key: string): ProbeVariant => ({
  marker,
  level: "Quote",
  // Digits only. A fictional 555-01xx number: its last two digits are the marker's.
  shape: { kind: "Value", key, value: `30455501${marker.slice(1)}` },
});

/** Keys added to the quote object, where buyerFirstName lives. */
export const QUOTE_VARIANTS: readonly ProbeVariant[] = [
  phone("P01", "buyerPhone"),
  phone("P02", "buyerPhoneNumber"),
  phone("P03", "buyerTelephone"),
  phone("P04", "buyerHomePhone"),
  phone("P05", "buyerCellPhone"),
  phone("P06", "buyerMobilePhone"),
  phone("P07", "buyerMobile"),
  phone("P08", "buyerPhone1"),
  phone("P09", "buyerDayPhone"),
  phone("P10", "buyerWorkPhone"),
  phone("P11", "BuyerPhone"),
  phone("P12", "buyerphone"),
  phone("P13", "buyer_phone"),
  phone("P14", "phone"),
  phone("P15", "phoneNumber"),
  phone("P16", "telephone"),
  phone("P17", "customerPhone"),
  phone("P18", "contactPhone"),
  phone("P19", "buyerPrimaryPhone"),
  phone("P20", "buyerEveningPhone"),
  // Round 1's winner, again, to confirm it repeats.
  pair("CB03", "cobuyerFirstName", "cobuyerLastName"),
];

/** Nothing goes at the top level of the payload in round 2. */
export const ROOT_VARIANTS: readonly ProbeVariant[] = [];

export type ProbeBatch = "All" | 1 | 2 | 3;

const CB03 = QUOTE_VARIANTS.filter((v) => v.marker === "CB03");
const ALL_VARIANTS = [...QUOTE_VARIANTS, ...ROOT_VARIANTS];
const phones = (from: number, to: number) =>
  QUOTE_VARIANTS.filter((v) => {
    if (!v.marker.startsWith("P")) return false;
    const n = Number(v.marker.slice(1));
    return n >= from && n <= to;
  });

/** Used only if TecAssured rejects the full set, and only when Jim says so. */
export const BATCHES: Readonly<Record<1 | 2 | 3, readonly ProbeVariant[]>> = {
  1: [...phones(1, 10), ...CB03],
  2: [...phones(11, 20), ...CB03],
  3: CB03,
};

/** "All", 1, 2 or 3, from a request. Anything else is null. A missing value is "All". */
export function parseProbeBatch(v: unknown): ProbeBatch | null {
  if (v === undefined || v === null || v === "" || v === "All") return "All";
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/^Batch\s*/i, "")) : NaN;
  return n === 1 || n === 2 || n === 3 ? n : null;
}

export function variantsFor(batch: ProbeBatch): readonly ProbeVariant[] {
  return batch === "All" ? ALL_VARIANTS : BATCHES[batch];
}

/** What a variant adds, as key and value. */
function entriesOf(v: ProbeVariant): [string, unknown][] {
  const code = v.marker;
  switch (v.shape.kind) {
    case "Pair":
      return [[v.shape.first, code], [v.shape.last, code]];
    case "Full name":
      return [[v.shape.key, `${code} ${code}`]];
    case "Object":
      return [[v.shape.key, { [v.shape.first]: code, [v.shape.last]: code }]];
    case "Value":
      return [[v.shape.key, v.shape.value]];
  }
}

/** One row of the marker table: markers only, never a name. */
export interface MarkerRow {
  marker: string;
  level: ProbeLevel;
  fields: string;
  sent: string;
}

export function markerRow(v: ProbeVariant): MarkerRow {
  const code = v.marker;
  switch (v.shape.kind) {
    case "Pair":
      return { marker: code, level: v.level, fields: `${v.shape.first} / ${v.shape.last}`, sent: `${code} / ${code}` };
    case "Full name":
      return { marker: code, level: v.level, fields: v.shape.key, sent: `${code} ${code}` };
    case "Object":
      return {
        marker: code,
        level: v.level,
        fields: `${v.shape.key}: { ${v.shape.first}, ${v.shape.last} }`,
        sent: `{ ${code}, ${code} }`,
      };
    case "Value":
      return { marker: code, level: v.level, fields: v.shape.key, sent: v.shape.value };
  }
}

export function markerTable(batch: ProbeBatch): MarkerRow[] {
  return variantsFor(batch).map(markerRow);
}

/**
 * Add a batch's variants to the quote and the top-level payload, in place.
 *
 * Refuses (throws) rather than overwrite a key that is already there: the
 * probe must never change what the real submit says about the real buyer.
 */
export function applyCobuyerProbe(
  quote: Record<string, unknown>,
  payload: Record<string, unknown>,
  batch: ProbeBatch
): MarkerRow[] {
  const variants = variantsFor(batch);
  for (const v of variants) {
    const target = v.level === "Quote" ? quote : payload;
    for (const [key] of entriesOf(v)) {
      if (key in target) throw new Error(`The co-buyer probe would overwrite ${key}, so nothing was sent.`);
    }
  }
  for (const v of variants) {
    const target = v.level === "Quote" ? quote : payload;
    for (const [key, value] of entriesOf(v)) target[key] = value;
  }
  return variants.map(markerRow);
}

// ── Which products may carry the probe ────────────────────────────────────
//
// Only forms with a co-buyer name row: Battery Standard and Care Coverage.
// Tire and Wheel has a co-buyer signature line but no name row, and Priority
// Maintenance has neither, so a probe on either could have a winning marker
// that prints nowhere. Matched on TecAssured's own program name (the product
// label in the quote, up to " - "): "RA BATTERY STANDARD USED", and every CARE
// program ("USED ON-ROAD CARE", "USED ATV/UTV CARE-SVC DRIVE" and the rest).

export const PROBE_PRODUCTS = "Battery Standard or Care Coverage";

export function probeAllows(programName: string | null | undefined): boolean {
  const p = String(programName ?? "").toUpperCase();
  return /^RA BATTERY STANDARD\b/.test(p) || /\bCARE\b/.test(p);
}

// ── Whether a submit carries the probe ────────────────────────────────────

export type ProbeDecision =
  | { kind: "Off" }
  | { kind: "Refuse"; message: string }
  | { kind: "On"; batch: ProbeBatch };

/**
 * The probe goes only on a test session whose submit has already passed the
 * QA-only contract guard, and only when asked for. Asked for anywhere else,
 * the flag is ignored entirely. Asked for with a product whose form has no
 * co-buyer name row, the submit is refused, because the test could not be read.
 */
export function probeDecision(input: {
  requested: unknown;
  batch: unknown;
  isTest: boolean;
  guardPassed: boolean;
  products: { name: string; program: string | null }[];
}): ProbeDecision {
  if (input.requested !== true || !input.isTest || !input.guardPassed) return { kind: "Off" };
  const batch = parseProbeBatch(input.batch);
  if (batch === null) {
    return {
      kind: "Refuse",
      message: `The field test batch must be All, 1, 2 or 3. Nothing was sent.`,
    };
  }
  const others = input.products.filter((p) => !probeAllows(p.program));
  if (others.length > 0) {
    return {
      kind: "Refuse",
      message:
        `The field test only works on ${PROBE_PRODUCTS}, the forms that print a co-buyer name. ` +
        `${others.map((p) => p.name).join(", ")} ${others.length === 1 ? "is" : "are"} also selected, ` +
        `so nothing was sent. Submit with only Battery Standard or Care Coverage chosen, or turn the test off.`,
    };
  }
  return { kind: "On", batch };
}
