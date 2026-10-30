// _shared/dx1-check.ts
//
// The F&I check against DX1 (fni-dx1-check, docs/multi-provider.md section
// 23). DX1 does not take writes, so F&I products are keyed into it by hand, and
// a CRM function pulls them into the DocuRide record's eight product slots.
// DX1 stays the source of truth for F&I money; PS never writes a CRM field
// here. It only compares those slots with the deal's live contracts when staff
// press Generate, to catch a keying mistake before documents are made.
//
// ── The slots (field names confirmed with getFields, 2026-10-30) ──────────
//   Sold_1_Warranty_*, Sold_1_GAP_*, Sold_1_PPM_*, Sold_1_Aftermarket_1_* to _5_*
//   _DSP   currency. An empty slot holds nothing (null) or 0.00.
//   _Desc  free text, up to 255 characters: what was keyed in DX1, often terse
//          and in capitals ("T&W OFFRD").
//   _Term  free text, up to 255 characters, not a picklist. Almost always
//          "<number> Months"; seen also "<number> MONTHS", a bare number, and
//          a not-applicable mark.
//   Sold_1_Contract_Tax is ignored.
//
// ── Pairing ───────────────────────────────────────────────────────────────
// Each live contract is paired with a filled slot. Every contract and slot is
// scored: its expected slot (Mechanical Protection to Warranty, GAP to GAP,
// Maintenance to PPM, anything else to an Aftermarket slot) is a hint worth 2,
// the same price 3, the same term 1, and how alike the descriptions are up to
// 2. The best pairs are taken first, and a pair needs at least 2: the right
// slot, or the right price, or a description that clearly names it. So a
// product keyed in an unexpected slot still pairs if it otherwise matches. A
// slot whose description clearly names another product at another price is
// never a pair: that is a product missing and another one extra, not a wrong
// price.
//
//   blocking   the price differs (exactly, to the cent); the term differs, or
//              cannot be read as months; a live contract has no slot; a filled
//              slot has no live contract (and says so if it matches a voided
//              one)
//   warnings   the description: "check it matches the contract" when partly
//              alike, and "does not look like this product" too when hardly at
//              all. Price and term carry the blocking.
//
// ── Descriptions ─────────────────────────────────────────────────────────
// Both sides are normalised: lower case, "&" and "/" as spaces, punctuation
// out, DMS shorthands expanded (T&W, OFFRD, MECH, MAINT, BATT, PROT, ...),
// words that mean the same kind of cover folded together (warranty, care,
// service contract), filler words dropped (plan, coverage, contract, the
// provider's own name, numbers). The score is the share of DX1's words found
// in the contract's product name, plan and category, a word counting as found
// when equal, when one starts the other (3 letters or more), or when one
// letter apart (5 letters or more).
//
//   0.6 and up         the same product: nothing said
//   0.3 up to 0.6      "check it matches the contract", DX1's wording shown
//   under 0.3          "does not look like this product", DX1's wording shown
//
// ── The lines ─────────────────────────────────────────────────────────────
// Staff read them in a CRM popup, under the gate's own heading and fix steps,
// and on Details. Each names the product the way the menu does (productName),
// puts the contract number in parentheses, and says plainly what is wrong:
//
//   Battery Protection (contract VLBTE001930-42120) has not been entered in DX1.
//   Tire and Wheel (contract TWOTE001930-5980): DX1 shows $585.00, but the
//     contract price is $595.00.
//   DX1 has a product in Aftermarket 2 for $199.00 that does not match any
//     contract on this deal.
//
// No line starts with "F&I": the gate adds its own heading.
//
// Pure, so a Node test can hold it. Plain English, values people read, no codes.

export const SLOTS = [
  { key: "Warranty", label: "Warranty" },
  { key: "GAP", label: "GAP" },
  { key: "PPM", label: "PPM" },
  { key: "Aftermarket_1", label: "Aftermarket 1" },
  { key: "Aftermarket_2", label: "Aftermarket 2" },
  { key: "Aftermarket_3", label: "Aftermarket 3" },
  { key: "Aftermarket_4", label: "Aftermarket 4" },
  { key: "Aftermarket_5", label: "Aftermarket 5" },
] as const;

/** Every CRM field the check reads, for a fetch that asks for these only. */
export const DX1_FIELDS: string[] = SLOTS.flatMap((s) => [
  `Sold_1_${s.key}_DSP`,
  `Sold_1_${s.key}_Desc`,
  `Sold_1_${s.key}_Term`,
]);

export const DESC_MATCH = 0.6;
export const DESC_CHECK = 0.3;

export type Status = "Nothing to check" | "Match" | "Problems";

export interface CheckResult {
  status: Status;
  blocking: string[];
  warnings: string[];
}

export const COULD_NOT_CHECK = "F&I contracts could not be checked against DX1";

export const NOTHING: CheckResult = { status: "Nothing to check", blocking: [], warnings: [] };
export const FAILED: CheckResult = { status: "Nothing to check", blocking: [], warnings: [COULD_NOT_CHECK] };

export interface Slot {
  key: string;
  label: string;
  /** In cents. */
  cents: number;
  desc: string | null;
  term: string | null;
}

export interface Contract {
  contract_number: string;
  category: string | null;
  product_name: string;
  plan: string | null;
  term_months: number | null;
  /** In cents, or null when the contract has no price on record. */
  cents: number | null;
  provider_name: string | null;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function toCents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** "$1,234.56". */
export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The filled slots of a CRM record: a price above zero. */
export function readSlots(record: Record<string, unknown>): Slot[] {
  return SLOTS.map((s) => ({
    key: s.key,
    label: s.label,
    cents: toCents(record[`Sold_1_${s.key}_DSP`]) ?? 0,
    desc: text(record[`Sold_1_${s.key}_Desc`]),
    term: text(record[`Sold_1_${s.key}_Term`]),
  })).filter((s) => s.cents > 0);
}

// ── Terms ─────────────────────────────────────────────────────────────────

/**
 * A term in months: "24", "24 months", "24 Mo", "24M", "2 years", "2 yr" are
 * all 24. Null when it cannot be read.
 */
export function termMonths(v: string | null): number | null {
  if (!v) return null;
  const s = v.trim().toLowerCase().replace(/\s+/g, " ");
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(months?|mos?|mths?|m|years?|yrs?|y)?\.?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "months";
  const months = /^y/.test(unit) ? n * 12 : n;
  return Number.isInteger(months) && months > 0 ? months : null;
}

/** "36 months", "1 month". */
function monthsText(n: number): string {
  return `${n} ${n === 1 ? "month" : "months"}`;
}

// ── Descriptions ──────────────────────────────────────────────────────────

/** Phrases first, so "t & w" is caught before "&" becomes a space. */
const PHRASES: [RegExp, string][] = [
  [/\bt\s*(?:&|and|\/|-)\s*w\b/g, " tire wheel "],
  [/\btw\b/g, " tire wheel "],
  [/\boff\s*-?\s*road\b|\boff\s*rd\b|\boffrd\b|\bofrd\b/g, " offroad "],
  [/\bon\s*-?\s*road\b|\bon\s*rd\b|\bonrd\b/g, " onroad "],
  [/\bside\s*by\s*side\b|\bsxs\b/g, " utv "],
  [/\bservice\s*contract\b|\bext(?:ended)?\s*(?:warr?a?n?t?y|svc|service)\b/g, " cover "],
  [/\banti\s*-?\s*theft\b/g, " theft "],
  [/\bpre\s*-?\s*paid\s*maint(?:enance)?\b/g, " maintenance "],
];

/** One word to its meaning. */
const WORDS: Record<string, string> = {
  mech: "cover", mechanical: "cover", warranty: "cover", warr: "cover", wty: "cover", war: "cover",
  care: "cover", vsc: "cover", esc: "cover", svc: "cover",
  maint: "maintenance", mnt: "maintenance", ppm: "maintenance", pm: "maintenance",
  batt: "battery", bat: "battery", btry: "battery",
  prot: "protection", protect: "protection",
  appear: "appearance", app: "appearance", etch: "theft",
  tires: "tire", wheels: "wheel", whl: "wheel", whls: "wheel",
  std: "standard", stnd: "standard", plat: "platinum", slvr: "silver", brz: "bronze",
};

/** Words that say nothing about which product it is. */
const FILLER = new Set([
  "the", "and", "of", "for", "a", "an", "with", "to", "in", "on",
  "plan", "plans", "coverage", "contract", "contracts", "program", "product", "package", "pkg",
  "protection", "agreement", "policy", "new", "used", "month", "months", "mo", "mos", "yr", "yrs",
  "year", "years", "term", "repl", "replacement", "waiver",
]);

/** A description as comparable words. `drop` adds words to ignore, such as the provider's name. */
export function descWords(s: string | null, drop: Set<string> = new Set()): string[] {
  if (!s) return [];
  let t = ` ${s.toLowerCase()} `;
  for (const [re, to] of PHRASES) t = t.replace(re, to);
  return t
    .replace(/[&/]/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => WORDS[w] ?? w)
    .filter((w) => !FILLER.has(w) && !drop.has(w) && !/^\d+$/.test(w));
}

function oneApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function wordFound(w: string, among: string[]): boolean {
  return among.some(
    (x) =>
      x === w ||
      (w.length >= 3 && x.length >= 3 && (x.startsWith(w) || w.startsWith(x))) ||
      (w.length >= 5 && x.length >= 5 && oneApart(w, x))
  );
}

/** How much of DX1's description is found in the contract's wording, 0 to 1; null with nothing to compare. */
export function descScore(dx1: string | null, c: Contract): number | null {
  const drop = new Set(descWords(c.provider_name ?? ""));
  const mine = descWords(dx1, drop);
  if (mine.length === 0) return null;
  const theirs = [
    ...descWords(c.product_name, drop),
    ...descWords(c.plan, drop),
    ...descWords(c.category, drop),
    ...(isGap(c) ? ["gap"] : []),
  ];
  return mine.filter((w) => wordFound(w, theirs)).length / mine.length;
}

// ── Pairing ───────────────────────────────────────────────────────────────

function isGap(c: Contract): boolean {
  return /\bgap\b/i.test(`${c.product_name} ${c.plan ?? ""} ${c.category ?? ""}`);
}

/** The slot a contract is expected in. */
export function expectedSlot(c: Contract): "Warranty" | "GAP" | "PPM" | "Aftermarket" {
  if (isGap(c)) return "GAP";
  if (c.category === "Mechanical Protection") return "Warranty";
  if (c.category === "Maintenance") return "PPM";
  return "Aftermarket";
}

function inExpected(c: Contract, s: Slot): boolean {
  const e = expectedSlot(c);
  return e === "Aftermarket" ? s.key.startsWith("Aftermarket") : s.key === e;
}

/** The plain names staff know, by catalog category. */
const PLAIN: Record<string, string> = {
  "Mechanical Protection": "Mechanical Protection",
  "Maintenance": "Maintenance",
  "Tire and Wheel": "Tire and Wheel",
  "Theft": "Theft",
  "Battery": "Battery Protection",
  "Appearance": "Appearance",
};

/** Words in a product's own wording that name it, for one with no category. */
const BY_WORDING: [RegExp, string][] = [
  [/\bcare\b/i, "Care Coverage"],
  [/\bbatt(?:ery)?\b/i, "Battery Protection"],
  [/\btire\b|\bwheel\b|\bt\s*&\s*w\b/i, "Tire and Wheel"],
  [/\btheft\b/i, "Theft"],
  [/\bmaint(?:enance)?\b/i, "Maintenance"],
];

/**
 * The product's plain name, the way staff see it on the menu: "Battery
 * Protection", "Tire and Wheel", "GAP". Never the provider's full title.
 */
export function productName(c: Contract): string {
  if (isGap(c)) return "GAP";
  const plain = c.category ? PLAIN[c.category] : undefined;
  if (plain) return plain;
  const wording = `${c.product_name} ${c.plan ?? ""}`;
  return BY_WORDING.find(([re]) => re.test(wording))?.[1] ?? "Product";
}

/** What a contract is called in a line: "Tire and Wheel (contract TWO-1)". */
export function contractName(c: Contract): string {
  return `${productName(c)} (contract ${c.contract_number})`;
}

function pairScore(c: Contract, s: Slot): number {
  let score = inExpected(c, s) ? 2 : 0;
  if (c.cents !== null && c.cents === s.cents) score += 3;
  const t = termMonths(s.term);
  if (c.term_months !== null && t !== null && t === c.term_months) score += 1;
  score += 2 * (descScore(s.desc, c) ?? 0);
  return score;
}

/** The best pairs first; each contract and slot used once; a pair needs a score of 2. */
export function pair(contracts: Contract[], slots: Slot[]): { pairs: [Contract, Slot][]; contracts: Contract[]; slots: Slot[] } {
  // A slot whose description clearly names another product, at another price,
  // is not this contract's, whatever slot it is in.
  const other = (c: Contract, s: Slot) => {
    const d = descScore(s.desc, c);
    return c.cents !== s.cents && d !== null && d < DESC_CHECK;
  };
  const all = contracts.flatMap((c, ci) =>
    slots.map((s, si) => ({ ci, si, score: other(c, s) ? 0 : pairScore(c, s) }))
  );
  all.sort((a, b) => b.score - a.score || a.ci - b.ci || a.si - b.si);
  const usedC = new Set<number>();
  const usedS = new Set<number>();
  const pairs: [Contract, Slot][] = [];
  for (const p of all) {
    if (p.score < 2 || usedC.has(p.ci) || usedS.has(p.si)) continue;
    usedC.add(p.ci);
    usedS.add(p.si);
    pairs.push([contracts[p.ci], slots[p.si]]);
  }
  return {
    pairs,
    contracts: contracts.filter((_, i) => !usedC.has(i)),
    slots: slots.filter((_, i) => !usedS.has(i)),
  };
}

// ── The comparison ────────────────────────────────────────────────────────

/** The live contracts against the CRM record's slots. `voided` helps say why a slot has no contract. */
export function compareToDx1(live: Contract[], voided: Contract[], record: Record<string, unknown>): CheckResult {
  if (live.length === 0) return NOTHING;
  const slots = readSlots(record);
  const { pairs, contracts, slots: spare } = pair(live, slots);
  const blocking: string[] = [];
  const warnings: string[] = [];

  for (const [c, s] of pairs) {
    const name = contractName(c);
    if (c.cents === null) {
      warnings.push(`${name}: DocuRide has no price on record for this contract, so the DX1 price of ${dollars(s.cents)} was not checked.`);
    } else if (c.cents !== s.cents) {
      blocking.push(`${name}: DX1 shows ${dollars(s.cents)}, but the contract price is ${dollars(c.cents)}.`);
    }

    const t = termMonths(s.term);
    if (c.term_months === null) {
      if (s.term !== null) blocking.push(`${name}: DX1 shows a term of "${s.term}", but the contract has no term.`);
    } else if (s.term === null) {
      blocking.push(`${name}: DX1 shows no term, but the contract term is ${monthsText(c.term_months)}.`);
    } else if (t === null) {
      blocking.push(`${name}: DX1 shows a term of "${s.term}", which is not a number of months. The contract term is ${monthsText(c.term_months)}.`);
    } else if (t !== c.term_months) {
      blocking.push(`${name}: DX1 shows ${monthsText(t)}, but the contract term is ${monthsText(c.term_months)}.`);
    }

    const d = descScore(s.desc, c);
    if (s.desc === null) {
      warnings.push(`${name}: DX1 has no description in ${s.label}. Add one that matches the contract.`);
    } else if (d !== null && d < DESC_CHECK) {
      warnings.push(`${name}: the DX1 description reads "${s.desc}", which does not look like this product. Check it matches the contract.`);
    } else if (d !== null && d < DESC_MATCH) {
      warnings.push(`${name}: the DX1 description reads "${s.desc}". Check it matches the contract.`);
    }
  }

  for (const c of contracts) {
    blocking.push(`${contractName(c)} has not been entered in DX1.`);
  }

  for (const s of spare) {
    const was = voided.find(
      (v) => (v.cents !== null && v.cents === s.cents) || (descScore(s.desc, v) ?? 0) >= DESC_MATCH
    );
    blocking.push(
      was
        ? `${contractName(was)} was voided, but DX1 still shows it in ${s.label} for ${dollars(s.cents)}.`
        : `DX1 has a product in ${s.label} for ${dollars(s.cents)} that does not match any contract on this deal.`
    );
  }

  return {
    status: blocking.length + warnings.length > 0 ? "Problems" : "Match",
    blocking,
    warnings,
  };
}

/** Whether two results say the same, for recording a change once. */
export function sameResult(a: CheckResult | null | undefined, b: CheckResult): boolean {
  return !!a && a.status === b.status && JSON.stringify(a.blocking) === JSON.stringify(b.blocking) &&
    JSON.stringify(a.warnings) === JSON.stringify(b.warnings);
}
