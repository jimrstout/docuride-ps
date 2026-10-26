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

/** Where a variant's keys go: the quote (beside buyerFirstName) or the top level. */
export type ProbeLevel = "Quote" | "Top level";

export interface ProbeVariant {
  marker: string;
  level: ProbeLevel;
  /** First and last name keys, one key holding both, or an object holding both. */
  shape:
    | { kind: "Pair"; first: string; last: string }
    | { kind: "Full name"; key: string }
    | { kind: "Object"; key: string; first: string; last: string };
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

/** Keys added to the quote object, where buyerFirstName lives. */
export const QUOTE_VARIANTS: readonly ProbeVariant[] = [
  pair("CB01", "coBuyerFirstName", "coBuyerLastName"),
  pair("CB02", "CoBuyerFirstName", "CoBuyerLastName"),
  pair("CB03", "cobuyerFirstName", "cobuyerLastName"),
  pair("CB04", "coBuyerFirstname", "coBuyerLastname"),
  pair("CB05", "cobuyerfirstname", "cobuyerlastname"),
  pair("CB06", "co_buyer_first_name", "co_buyer_last_name"),
  pair("CB07", "coBuyer_FirstName", "coBuyer_LastName"),
  pair("CB08", "co-buyerFirstName", "co-buyerLastName"),
  pair("CB09", "Co-BuyerFirstName", "Co-BuyerLastName"),
  pair("CB10", "co-buyer-first-name", "co-buyer-last-name"),
  pair("CB11", "coFirstName", "coLastName"),
  pair("CB12", "CoFirstName", "CoLastName"),
  pair("CB13", "coFirstname", "coLastname"),
  pair("CB14", "co_first_name", "co_last_name"),
  pair("CB15", "co-FirstName", "co-LastName"),
  pair("CB16", "Co-FirstName", "Co-LastName"),
  pair("CB17", "cobuyerFName", "cobuyerLName"),
  pair("CB18", "coBuyerFName", "coBuyerLName"),
  pair("CB19", "secondBuyerFirstName", "secondBuyerLastName"),
  pair("CB20", "buyer2FirstName", "buyer2LastName"),
  pair("CB21", "Buyer2FirstName", "Buyer2LastName"),
  pair("CB22", "jointBuyerFirstName", "jointBuyerLastName"),
  pair("CB23", "coApplicantFirstName", "coApplicantLastName"),
  pair("CB24", "coOwnerFirstName", "coOwnerLastName"),
  pair("CB25", "coPurchaserFirstName", "coPurchaserLastName"),
  full("CB26", "coBuyerName"),
  full("CB27", "cobuyerName"),
  full("CB28", "CoBuyerName"),
  full("CB29", "coBuyerFullName"),
  obj("CB30", "coBuyer", "firstName", "lastName"),
  obj("CB31", "cobuyer", "firstName", "lastName"),
  obj("CB32", "CoBuyer", "FirstName", "LastName"),
  obj("CB33", "co-buyer", "firstName", "lastName"),
  pair("CB34", "contractHolder2FirstName", "contractHolder2LastName"),
  pair("CB35", "coContractHolderFirstName", "coContractHolderLastName"),
  pair("CB36", "secondContractHolderFirstName", "secondContractHolderLastName"),
  pair("CB37", "COBuyerFirstName", "COBuyerLastName"),
  pair("CB38", "Co_BuyerFirstName", "Co_BuyerLastName"),
  pair("CB39", "additionalBuyerFirstName", "additionalBuyerLastName"),
  pair("CB40", "secondaryBuyerFirstName", "secondaryBuyerLastName"),
  pair("CB41", "owner2FirstName", "owner2LastName"),
];

/** Keys added to the top-level submit payload: the same names, other markers. */
export const ROOT_VARIANTS: readonly ProbeVariant[] = [
  pair("R01", "coBuyerFirstName", "coBuyerLastName", "Top level"),
  pair("R02", "CoBuyerFirstName", "CoBuyerLastName", "Top level"),
  obj("R03", "coBuyer", "firstName", "lastName", "Top level"),
];

export type ProbeBatch = "All" | 1 | 2 | 3;

const ALL_VARIANTS = [...QUOTE_VARIANTS, ...ROOT_VARIANTS];
const range = (from: number, to: number) =>
  QUOTE_VARIANTS.filter((v) => {
    const n = Number(v.marker.slice(2));
    return n >= from && n <= to;
  });

/** Used only if TecAssured rejects the full set, and only when Jim says so. */
export const BATCHES: Readonly<Record<1 | 2 | 3, readonly ProbeVariant[]>> = {
  1: range(1, 12),
  2: range(13, 25),
  3: [...range(26, 41), ...ROOT_VARIANTS],
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
      message: `The co-buyer field test batch must be All, 1, 2 or 3. Nothing was sent.`,
    };
  }
  const others = input.products.filter((p) => !probeAllows(p.program));
  if (others.length > 0) {
    return {
      kind: "Refuse",
      message:
        `The co-buyer field test only works on ${PROBE_PRODUCTS}, the forms that print a co-buyer name. ` +
        `${others.map((p) => p.name).join(", ")} ${others.length === 1 ? "is" : "are"} also selected, ` +
        `so nothing was sent. Submit with only Battery Standard or Care Coverage chosen, or turn the test off.`,
    };
  }
  return { kind: "On", batch };
}
