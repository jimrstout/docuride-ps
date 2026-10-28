// _shared/contract-parties.ts
//
// Who goes on the contracts: the buyer, the co-buyer and the lienholder.
//
// fni.sessions holds them as the CRM sent them, and they are what a submit
// sends TecAssured. Staff see every one of them on Details and can correct
// any, so a misspelled name no longer means correcting DX1, then the CRM, then
// refreshing before a contract can go out.
//
// ── The same layer as every other correction ──────────────────────────────
// An edit is a StaffEdit in fni.sessions.staff_edits, keyed on the column it
// corrects (buyer_last_name), with who, when, and the value it replaced. The
// columns keep what the CRM says, so a Refresh from CRM never overwrites an
// edit, and applyStaffEdits is the one place the two are put together: the
// screen and the submit read the same values. See _shared/staff-edits.ts.
//
// Removing a co-buyer or lienholder the CRM sent is an edit too: the key
// "cobuyer" or "lienholder" with the value "Removed". applyStaffEdits then
// treats every column of that party as blank.
//
// ── Kept in step with DX1 ─────────────────────────────────────────────────
// The finance contract comes from DX1, not from here. So every change made
// here is listed at Submit, and the person submitting confirms they have made
// it in DX1 too, or that it is not needed there (fni-contract-submit).
//
// ── Locked once a contract is live ────────────────────────────────────────
// A live contract was registered with these details. Changing them afterwards
// would make DocuRide disagree with the contracts, so they are read-only until
// every live contract is voided.
//
// Pure, with no remote imports, so a Node test can hold it.

import type { StaffEdit, StaffEdits } from "./staff-edits.ts";

export type PartyName = "Buyer" | "Co-buyer" | "Lienholder";

export type PartyInput = "text" | "type" | "state" | "zip" | "phone" | "email";

export interface PartyFieldSpec {
  /** The fni.sessions column, and the staff_edits key. */
  key: string;
  party: PartyName;
  label: string;
  input: PartyInput;
}

const person = (prefix: "buyer" | "cobuyer", party: PartyName): PartyFieldSpec[] => [
  { key: `${prefix}_type`, party, label: "Type", input: "type" },
  { key: `${prefix}_display_name`, party, label: "Name as it prints", input: "text" },
  { key: `${prefix}_first_name`, party, label: "First name", input: "text" },
  { key: `${prefix}_last_name`, party, label: "Last name", input: "text" },
  { key: `${prefix}_address`, party, label: "Street address", input: "text" },
  { key: `${prefix}_city`, party, label: "City", input: "text" },
  { key: `${prefix}_state`, party, label: "State", input: "state" },
  { key: `${prefix}_zip`, party, label: "ZIP", input: "zip" },
  { key: `${prefix}_phone`, party, label: "Phone", input: "phone" },
  { key: `${prefix}_email`, party, label: "Email", input: "email" },
];

/** Every field, in the order the panels show them. */
export const PARTY_FIELDS: readonly PartyFieldSpec[] = [
  ...person("buyer", "Buyer"),
  ...person("cobuyer", "Co-buyer"),
  { key: "lienholder_name", party: "Lienholder", label: "Name", input: "text" },
  { key: "lienholder_address", party: "Lienholder", label: "Street address", input: "text" },
  { key: "lienholder_city", party: "Lienholder", label: "City", input: "text" },
  { key: "lienholder_state", party: "Lienholder", label: "State", input: "state" },
  { key: "lienholder_zip", party: "Lienholder", label: "ZIP", input: "zip" },
  { key: "lienholder_phone", party: "Lienholder", label: "Phone", input: "phone" },
];

export const PARTY_KEYS: readonly string[] = PARTY_FIELDS.map((f) => f.key);

/** The two parties a deal can be without, and the edit key that removes each. */
export const REMOVABLE: Readonly<Record<"Co-buyer" | "Lienholder", string>> = {
  "Co-buyer": "cobuyer",
  Lienholder: "lienholder",
};

/** The stored value of a removal. */
export const REMOVED = "Removed";

/** The buyer types the CRM uses, as stored. A Company is a business buyer. */
export const PARTY_TYPES = ["Individual", "Company"] as const;

export function isPartyKey(key: string): boolean {
  return PARTY_KEYS.includes(key);
}

export function partyOf(key: string): PartyName | null {
  return PARTY_FIELDS.find((f) => f.key === key)?.party ?? null;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** The party a removal key stands for. */
function removedParties(edits: StaffEdits): Set<PartyName> {
  const out = new Set<PartyName>();
  for (const [party, key] of Object.entries(REMOVABLE) as [PartyName, string][]) {
    if (edits[key]?.value === REMOVED) out.add(party);
  }
  return out;
}

/**
 * Blank every column of a removed party, in place on a copy applyStaffEdits
 * made. Called by applyStaffEdits after the field edits are applied.
 */
export function applyPartyRemovals(row: Record<string, unknown>, edits: StaffEdits): void {
  const removed = removedParties(edits);
  for (const f of PARTY_FIELDS) if (removed.has(f.party)) row[f.key] = null;
}

// ── Checking what was typed ───────────────────────────────────────────────

/**
 * The value to store, or a plain-English reason it will not do. Stored as the
 * person would read it: a state as two capital letters, everything else as
 * typed.
 */
export function partyValue(spec: PartyFieldSpec, raw: string): { value: string } | { problem: string } {
  const v = raw.trim();
  const name = `${spec.party} ${spec.label.toLowerCase()}`;
  switch (spec.input) {
    case "type": {
      const t = PARTY_TYPES.find((p) => p.toLowerCase() === v.toLowerCase());
      return t ? { value: t } : { problem: `${spec.party} type must be Individual or Company.` };
    }
    case "state":
      return /^[A-Za-z]{2}$/.test(v) ? { value: v.toUpperCase() } : { problem: `${name} must be two letters, like WV.` };
    case "zip":
      return /^\d{5}(-\d{4})?$/.test(v) ? { value: v } : { problem: `${name} must be five digits, or five and four, like 26101 or 26101-1234.` };
    case "phone": {
      const digits = v.replace(/\D/g, "");
      return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"))
        ? { value: v }
        : { problem: `${name} must be a ten-digit phone number.` };
    }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? { value: v } : { problem: `${name} is not an email address.` };
    default:
      return { value: v };
  }
}

// ── What the panels show ──────────────────────────────────────────────────

export interface PartyField {
  key: string;
  label: string;
  input: PartyInput;
  /** What goes on the contracts: the staff value where there is one. */
  value: string | null;
  /** What the CRM says now. */
  crm_value: string | null;
  edited: boolean;
  /** The value the edit replaced, as it was when the edit was made. */
  was: string | null;
  edited_by: string | null;
  edited_at: string | null;
  /**
   * The CRM has changed since the edit, to something other than the staff
   * value. Both are shown, with Keep staff value and Use CRM value.
   */
  crm_changed: boolean;
  /** "Missing: buyer last name", when the contracts need it and it is blank. */
  missing: string | null;
}

export interface Party {
  party: PartyName;
  /** There is one on this deal, as it now stands. */
  present: boolean;
  /** The CRM deal carries one. */
  in_crm: boolean;
  /** Staff removed the one the CRM sent. */
  removed: { by: string; at: string } | null;
  /** A business (type Company): the panel leads with the business name. */
  business: boolean;
  /** The name a person reads first: the business name, or first and last. */
  heading: string | null;
  fields: PartyField[];
  missing: string[];
}

export interface PartyChange {
  key: string;
  party: PartyName;
  label: string;
  was: string | null;
  now: string | null;
}

export interface ContractParties {
  parties: Party[];
  /** A live contract was registered with these details. */
  locked: boolean;
  lock_reason: string | null;
  /** Every change made here, for the confirmation at Submit. */
  changes: PartyChange[];
}

export const LOCK_REASON =
  "These details are locked because a contract on this deal is live with them. Changing them would no longer " +
  "match the registered contracts. Void every live contract on this deal to change them.";

export const DX1_REMINDER =
  "This changes what prints on the service contracts. Make the same change in DX1 so the finance contract matches.";

export const DX1_CONFIRMATION = "I have made these changes in DX1, or they are not needed there.";

const NEEDED_ALWAYS = new Set(["address", "city", "state", "zip"]);

function missingFor(party: PartyName, f: PartyFieldSpec, business: boolean, value: string | null): string | null {
  if (value !== null) return null;
  const field = f.key.replace(/^(buyer|cobuyer|lienholder)_/, "");
  const who = party.toLowerCase();
  if (party === "Lienholder") {
    if (field === "name" || NEEDED_ALWAYS.has(field)) return `Missing: lienholder ${f.label.toLowerCase()}`;
    return null;
  }
  if (business && field === "display_name") return `Missing: ${who} business name`;
  if (!business && (field === "first_name" || field === "last_name")) return `Missing: ${who} ${f.label.toLowerCase()}`;
  if (party === "Buyer" && NEEDED_ALWAYS.has(field)) {
    return `Missing: buyer ${field === "address" ? "address" : f.label.toLowerCase()}`;
  }
  return null;
}

/**
 * The three panels, from the session as the CRM left it and the staff layer.
 * `live` is whether any contract on the deal is live.
 */
export function contractParties(row: Record<string, unknown>, edits: StaffEdits, live: boolean): ContractParties {
  const removed = removedParties(edits);
  const parties: Party[] = (["Buyer", "Co-buyer", "Lienholder"] as PartyName[]).map((party) => {
    const specs = PARTY_FIELDS.filter((f) => f.party === party);
    const isRemoved = removed.has(party);
    const in_crm = specs.some((f) => text(row[f.key]) !== null);
    const fields = specs.map((f) => {
      const crm = text(row[f.key]);
      const edit: StaffEdit | undefined = isRemoved ? undefined : edits[f.key];
      const value = isRemoved ? null : edit ? text(edit.value) : crm;
      const was = edit ? edit.original : null;
      return {
        key: f.key,
        label: f.label,
        input: f.input,
        value,
        crm_value: crm,
        edited: edit !== undefined,
        was,
        edited_by: edit?.edited_by ?? null,
        edited_at: edit?.edited_at ?? null,
        crm_changed: edit !== undefined && crm !== was && crm !== value,
        missing: null as string | null,
      };
    });
    const present = party === "Buyer" || (!isRemoved && fields.some((f) => f.value !== null));
    const type = fields.find((f) => f.input === "type")?.value ?? null;
    const business = type === "Company";
    const get = (suffix: string) => fields.find((f) => f.key.endsWith(suffix))?.value ?? null;
    const heading = business
      ? get("_display_name")
      : ([get("_first_name"), get("_last_name")].filter(Boolean).join(" ") || get("_display_name") || get("_name"));
    if (present) {
      fields.forEach((f, i) => (f.missing = missingFor(party, specs[i], business, f.value)));
    }
    const removalKey = party === "Buyer" ? null : REMOVABLE[party];
    const removal = removalKey && isRemoved ? edits[removalKey] : undefined;
    return {
      party,
      present,
      in_crm,
      removed: removal ? { by: removal.edited_by, at: removal.edited_at } : null,
      business,
      heading,
      fields,
      missing: fields.map((f) => f.missing).filter((m): m is string => m !== null),
    };
  });

  return {
    parties,
    locked: live,
    lock_reason: live ? LOCK_REASON : null,
    changes: partyChanges(row, edits),
  };
}

/**
 * Every change to who goes on the contracts, in panel order: each edited
 * field with what it was and what it is now, and each party removed.
 */
export function partyChanges(row: Record<string, unknown>, edits: StaffEdits): PartyChange[] {
  const removed = removedParties(edits);
  const out: PartyChange[] = [];
  for (const party of ["Co-buyer", "Lienholder"] as const) {
    if (removed.has(party)) {
      const was = PARTY_FIELDS.filter((f) => f.party === party).map((f) => text(row[f.key])).filter(Boolean).join(", ");
      out.push({ key: REMOVABLE[party], party, label: `${party} removed`, was: was || null, now: null });
    }
  }
  for (const f of PARTY_FIELDS) {
    if (removed.has(f.party)) continue;
    const e = edits[f.key];
    if (!e) continue;
    out.push({ key: f.key, party: f.party, label: `${f.party} ${f.label.toLowerCase()}`, was: e.original, now: text(e.value) });
  }
  return out;
}
