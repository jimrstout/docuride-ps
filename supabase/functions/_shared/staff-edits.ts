// _shared/staff-edits.ts
//
// Staff corrections to rating inputs: what they are, how they reach a rate
// request, and when they disagree with the CRM deal.
//
// ── The rule this implements ─────────────────────────────────────────────
// Every field that feeds a rate is editable on the Verify screen, including the
// ones the CRM owns. That replaces the old "read-only, correct it in CRM" rule,
// which was honest about ownership and useless in the room: an F&I manager
// holding the machine's papers could see a wrong odometer and not fix it, so the
// rate went out wrong or the deal stalled on someone else's data entry.
//
// The trade is that DocuRide can now hold a figure the CRM does not. That is not
// hidden: an edited field shows its original and its source, the person's name
// is on it, and a warning names every value that no longer matches the deal
// until the deal is brought into line. Nothing is written back to Zoho
// automatically, because a contract-generation tool silently rewriting the
// dealer's own deal record is a different and much larger promise.
//
// ── Where the edits sit ──────────────────────────────────────────────────
// fni.sessions.staff_edits, a layer over the session's columns rather than a
// replacement for them. See migration 0016 for why. `applyStaffEdits` is the one
// place the layer is flattened, and both readers that matter -- the Verify sheet
// and the rate request -- go through it, so the screen cannot show one set of
// numbers while the provider is quoted another.

/** One correction, as recorded the moment it was made. */
export interface StaffEdit {
  /** Exactly what the person typed. Cast when applied, not when stored. */
  value: string;
  /** The value being corrected, as the sheet displayed it. */
  original: string | null;
  /** Where that original came from: CRM, VIN Decode, Missing, and so on. */
  original_source: string;
  edited_by: string;
  edited_at: string;
}

export type StaffEdits = Record<string, StaffEdit>;

/** The label an edited field's source reads as. Shown as written. */
export const EDITED_SOURCE = "Edited by Staff";

/**
 * How a field key reaches the session.
 *
 * `column` is a real fni.sessions column and the value is cast to its type.
 * `property` is a key in sessions.vehicle_properties, which is where the fields
 * no system carries already live and where the rate builder already looks.
 */
export type EditTarget =
  | { kind: "column"; column: string; cast: "text" | "number" | "integer" | "date" }
  | { kind: "property"; key: string };

/**
 * Where an edit to each field lands.
 *
 * Here rather than beside the Verify screen's display specs, because this is not
 * a display concern: it is how a correction reaches the session, and three
 * readers need it. Two of them -- fni-rate-vehicle and fni-session-get -- have no
 * business importing a staff screen's field list to find out, and the planner
 * least of all.
 *
 * A key absent from this table cannot be edited at all. That is exactly two
 * fields: Deal # and Stock #, which identify the deal rather than feeding a rate.
 */
export const EDIT_TARGETS: Record<string, EditTarget> = {
  // Deal
  deal_type: { kind: "column", column: "finance_type", cast: "text" },
  sale_date: { kind: "column", column: "sale_date", cast: "date" },

  // Vehicle
  vin: { kind: "column", column: "vin", cast: "text" },
  unit_year: { kind: "column", column: "unit_year", cast: "integer" },
  unit_make: { kind: "column", column: "unit_make", cast: "text" },
  unit_model: { kind: "column", column: "unit_model", cast: "text" },
  condition: { kind: "column", column: "condition", cast: "text" },
  vehicle_type_code: { kind: "column", column: "vehicle_type_code", cast: "text" },
  odometer: { kind: "column", column: "odometer", cast: "integer" },
  in_service_date: { kind: "column", column: "in_service_date", cast: "date" },
  "engine.ccs": { kind: "property", key: "engine.ccs" },
  warranty: { kind: "property", key: "warranty" },
  "fuel.type": { kind: "property", key: "fuel.type" },

  // Money
  sale_price: { kind: "column", column: "sale_price", cast: "number" },
  amount_financed: { kind: "column", column: "amount_financed", cast: "number" },
  finance_term: { kind: "column", column: "finance_term", cast: "integer" },
  apr: { kind: "column", column: "apr", cast: "number" },

  // Customer. All three reach the rate request as customerCity, customerState
  // and customerPostalCode, so all three are editable.
  buyer_city: { kind: "column", column: "buyer_city", cast: "text" },
  buyer_state: { kind: "column", column: "buyer_state", cast: "text" },
  buyer_zip: { kind: "column", column: "buyer_zip", cast: "text" },
};

export function editTargetFor(key: string): EditTarget | null {
  return EDIT_TARGETS[key] ?? null;
}

export function parseStaffEdits(raw: unknown): StaffEdits {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: StaffEdits = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.value !== "string" || e.value.trim() === "") continue;
    out[key] = {
      value: e.value,
      original: typeof e.original === "string" ? e.original : null,
      original_source: typeof e.original_source === "string" ? e.original_source : "Missing",
      edited_by: typeof e.edited_by === "string" ? e.edited_by : "unknown",
      edited_at: typeof e.edited_at === "string" ? e.edited_at : "",
    };
  }
  return out;
}

// ── Casting ───────────────────────────────────────────────────────────────

function asNumber(v: string): number | null {
  const n = parseFloat(v.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function asDate(v: string): string | null {
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
}

/**
 * Deal type, back from the word staff read to the word the column holds.
 *
 * The screen says Cash, Finance and Lease because that is what an F&I manager
 * calls them. fni.sessions.finance_type holds Cash, Loan and Lease. Without this
 * the round trip loses: a person picks "Finance" and the column gets a value no
 * CHECK allows.
 */
export function financeTypeColumnValue(v: string): string | null {
  const lower = v.trim().toLowerCase();
  if (lower === "cash" || lower === "none") return "Cash";
  if (lower === "finance" || lower === "loan") return "Loan";
  if (lower === "lease") return "Lease";
  return null;
}

/** New or Used, back from the word the screen shows. */
function conditionColumnValue(v: string): string | null {
  const lower = v.trim().toLowerCase();
  if (lower === "new") return "New";
  if (lower === "used" || lower === "pre-owned") return "Used";
  return null;
}

/**
 * The value to put in the column, or null when the text cannot be one.
 *
 * Null means the edit is dropped rather than applied, which leaves the CRM value
 * standing. That is the safe direction: a typo in a price must never become a
 * NaN on a rate request.
 */
export function castForColumn(
  target: Extract<EditTarget, { kind: "column" }>,
  raw: string
): unknown {
  const v = raw.trim();
  if (v === "") return null;

  if (target.column === "finance_type") return financeTypeColumnValue(v);
  if (target.column === "condition") return conditionColumnValue(v);

  // TecAssured's vehicle types are upper-case, and the required-properties cache
  // is keyed on them exactly. Somebody typing "utv" would otherwise miss the
  // cache, get an Unavailable answer, and be told the machine cannot be rated.
  if (target.column === "vehicle_type_code") return v.toUpperCase();

  switch (target.cast) {
    case "number":
      return asNumber(v);
    case "integer": {
      const n = asNumber(v);
      return n === null ? null : Math.round(n);
    }
    case "date":
      return asDate(v);
    default:
      return v;
  }
}

/**
 * The session as rating and the screen should see it: CRM's record with the
 * staff layer on top.
 *
 * A copy. The row itself is never mutated, so a caller that also wants the
 * unedited values (to show "was $24,000.00") still has them.
 */
export function applyStaffEdits(
  session: Record<string, unknown>,
  edits: StaffEdits,
  targetFor: (key: string) => EditTarget | null = editTargetFor
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...session };

  const props: Record<string, unknown> = {
    ...((session.vehicle_properties ?? {}) as Record<string, unknown>),
  };
  let propsTouched = false;

  for (const [key, edit] of Object.entries(edits)) {
    const target = targetFor(key);
    if (!target) continue;

    if (target.kind === "property") {
      props[target.key] = edit.value;
      propsTouched = true;
      continue;
    }

    const cast = castForColumn(target, edit.value);
    // A value that will not cast is not applied. The CRM figure stands and the
    // screen keeps showing the edit as the person typed it, so the mismatch is
    // visible rather than silently swallowed.
    if (cast !== null) out[target.column] = cast;
  }

  if (propsTouched) out.vehicle_properties = props;
  return out;
}

// ── Disagreeing with the deal ─────────────────────────────────────────────

/** One field whose edited value is not what the CRM deal says. */
export interface CrmMismatch {
  key: string;
  label: string;
  /** What the CRM says now, as the sheet would show it. */
  crm_value: string | null;
  /** What the edit says, as the sheet shows it. */
  edited_value: string | null;
  edited_by: string;
  edited_at: string;
}

/**
 * Jim's sentence, with the field labels in it.
 *
 * Kept here rather than in the page so the Edge Function and the screen cannot
 * word the same warning two ways. Plain English, no em dash.
 */
export function crmMismatchWarning(mismatches: CrmMismatch[]): string | null {
  if (mismatches.length === 0) return null;
  return (
    `These values now differ from the CRM deal: ` +
    `${mismatches.map((m) => m.label).join(", ")}. ` +
    `Update the deal in CRM so the sale documents match.`
  );
}
