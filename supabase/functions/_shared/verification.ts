// _shared/verification.ts
//
// The sheet a staff member checks before anything is rated, and the gate that
// decides whether it has been.
//
// ── Why one module rather than a screen and a check ──────────────────────
// The Verify button must be disabled by exactly the same reasoning that would
// refuse the rate. Two implementations of "is this ready" drift, and the drift
// is silent in the worst direction: a screen that says ready over a request that
// is not. So the screen renders what this returns and the gate reads `ready`
// from the same call.
//
// ── Where a value came from is part of the value ─────────────────────────
// A price built on a default nobody chose is the failure this whole screen
// exists to prevent, so every field carries its provenance and the screen shows
// it. The sources are real and distinct:
//
//   CRM               From the Zoho deal. Read-only here: the deal is the
//                     record, and editing a copy of it would put the planner and
//                     the contract out of step. Corrected in Zoho, then
//                     Refreshed.
//   DX1               From the DMS. Photos only today; no rating input comes
//                     from it. Named anyway, because it is a source staff know
//                     and its absence from this list is itself informative.
//   VIN Decode        From TecAssured's own /decode/ps. Engine size, fuel type,
//                     and its opinion of the vehicle type.
//   Entered by Staff  Typed on this screen, into sessions.vehicle_properties.
//                     Only for fields no source carries.
//   Missing           No value from anywhere.

/** Where a value came from. Human-readable, because it is shown as written. */
export type FieldSource =
  | "CRM"
  | "DX1"
  | "VIN Decode"
  | "Entered by Staff"
  | "Missing";

export type FieldGroup = "Deal" | "Vehicle" | "Money" | "Customer";

export interface VerifyField {
  /** Stable key. Also the form field name when the field is editable. */
  key: string;
  label: string;
  group: FieldGroup;
  /** As it should read to the person checking it. Null when there is nothing. */
  value: string | null;
  source: FieldSource;
  /** Staff may type it here. False for everything the CRM owns. */
  editable: boolean;
  /** The TecAssured property this answers, when it answers one. */
  provider_property: string | null;
  /** requiredproperties named this for this vehicle type. */
  required: boolean;
  /** Required and empty. What the screen highlights and the gate counts. */
  missing: boolean;
  /** Shown under a read-only field, or as help under an editable one. */
  note: string | null;
}

export interface VerificationSheet {
  fields: VerifyField[];
  /** Required and empty, in the order they appear. */
  missing: VerifyField[];
  /** Every required field has a value, so Verify may be pressed. */
  ready: boolean;
  /**
   * Provider properties we could not attach to any field on this sheet.
   *
   * Empty today. It is here because requiredproperties differs by vehicle type
   * and by dealer, and a property nobody has seen before must show up as a gap
   * on the screen rather than pass silently: an unattached required property is
   * a field a person cannot fill in, which the gate must not call ready.
   */
  unmapped_properties: string[];
}

const CORRECT_IN_CRM = "Correct this in CRM, then click Refresh.";

// ── Reading values ────────────────────────────────────────────────────────

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** A dollar figure as a person reads it, or null. */
function money(v: unknown): string | null {
  const n = v === null || v === undefined || v === "" ? NaN : Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * How the deal type reads.
 *
 * fni.sessions.finance_type holds Cash or Loan, derived by fni-session-start
 * from whether a lienholder is attached. "Finance" is the word staff use for
 * Loan, and Lease is carried so the sheet is honest about the third case the
 * moment a lease deal appears rather than mislabelling it.
 */
export function dealTypeLabel(financeType: unknown): string | null {
  const v = text(financeType);
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === "cash" || lower === "none") return "Cash";
  if (lower === "loan" || lower === "finance") return "Finance";
  if (lower === "lease") return "Lease";
  return v;
}

/** New or Used, in the CRM's own words where they are usable. */
function conditionLabel(condition: unknown): string | null {
  const v = text(condition);
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === "new") return "New";
  if (lower === "used" || lower === "pre-owned") return "Used";
  return v;
}

// ── What the sheet is built from ──────────────────────────────────────────

/** The session columns this sheet reads. A subset of fni.sessions on purpose. */
export interface VerificationSource {
  deal_number: unknown;
  stock_number: unknown;
  finance_type: unknown;
  sale_date: unknown;

  vin: unknown;
  unit_year: unknown;
  unit_make: unknown;
  unit_model: unknown;
  condition: unknown;
  vehicle_type_code: unknown;
  odometer: unknown;
  in_service_date: unknown;

  sale_price: unknown;
  amount_financed: unknown;
  finance_term: unknown;
  apr: unknown;

  buyer_city: unknown;
  buyer_state: unknown;
  buyer_zip: unknown;

  /** Typed by staff on this screen. Keys are lowercased property names. */
  vehicle_properties: Record<string, unknown> | null;
  /** Verbatim /decode/ps response, or null if it has not been called. */
  vin_decode: Record<string, unknown> | null;
}

/**
 * The staff-entered fields, by the key the form uses.
 *
 * Only two, and both for the same reason: nothing else in the system knows them.
 * Engine size is answerable by the VIN decode, so it is editable as a
 * correction rather than as the only way in. Warranty months is answerable by
 * nobody, which is the entire argument for this screen existing.
 */
export const STAFF_ENTERED = {
  engineCc: "engine.ccs",
  warrantyMonths: "warranty",
} as const;

function staffValue(src: VerificationSource, name: string): string | null {
  const props = src.vehicle_properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  for (const [k, v] of Object.entries(props)) {
    if (k.toLowerCase() === name.toLowerCase()) return text(v);
  }
  return null;
}

function decoded(src: VerificationSource, key: string): string | null {
  const d = src.vin_decode;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  return text(d[key]);
}

// ── The sheet ─────────────────────────────────────────────────────────────

interface Spec {
  key: string;
  label: string;
  group: FieldGroup;
  provider_property: string | null;
  /** Resolved value and where it came from, in precedence order. */
  resolve: (src: VerificationSource) => { value: string | null; source: FieldSource };
  editable?: boolean;
  note?: string | null;
}

/** A value the CRM owns. Read-only, and says so when it is empty. */
function fromCrm(value: string | null) {
  return { value, source: (value === null ? "Missing" : "CRM") as FieldSource };
}

/**
 * Staff entry wins over the decode, and the decode over nothing.
 *
 * That order is deliberate. The decode is a good source and it is still a
 * lookup against a VIN pattern; a person holding the machine's papers beats it,
 * and the screen shows which of the two is in force.
 */
function staffThenDecode(
  src: VerificationSource,
  staffKey: string,
  decodeKey: string
): { value: string | null; source: FieldSource } {
  const typed = staffValue(src, staffKey);
  if (typed !== null) return { value: typed, source: "Entered by Staff" };
  const auto = decoded(src, decodeKey);
  if (auto !== null) return { value: auto, source: "VIN Decode" };
  return { value: null, source: "Missing" };
}

const SPECS: Spec[] = [
  // ── Deal ───────────────────────────────────────────────────────────────
  {
    key: "deal_number", label: "Deal #", group: "Deal", provider_property: null,
    resolve: (s) => fromCrm(text(s.deal_number)),
    note: CORRECT_IN_CRM,
  },
  {
    key: "stock_number", label: "Stock #", group: "Deal", provider_property: null,
    resolve: (s) => fromCrm(text(s.stock_number)),
    note: CORRECT_IN_CRM,
  },
  {
    key: "deal_type", label: "Deal type", group: "Deal", provider_property: "finance.type",
    resolve: (s) => fromCrm(dealTypeLabel(s.finance_type)),
    note: "Cash, Finance or Lease. Set in CRM by whether a lienholder is attached.",
  },
  {
    key: "sale_date", label: "Sale date", group: "Deal", provider_property: "sale.date",
    resolve: (s) => fromCrm(text(s.sale_date)),
    note: CORRECT_IN_CRM,
  },

  // ── Vehicle ────────────────────────────────────────────────────────────
  {
    key: "vin", label: "VIN", group: "Vehicle", provider_property: "vin",
    resolve: (s) => fromCrm(text(s.vin)),
    note: CORRECT_IN_CRM,
  },
  {
    key: "unit_year", label: "Year", group: "Vehicle", provider_property: "year",
    resolve: (s) => fromCrm(text(s.unit_year)),
    note: CORRECT_IN_CRM,
  },
  {
    key: "unit_make", label: "Make", group: "Vehicle", provider_property: "make",
    resolve: (s) => fromCrm(text(s.unit_make)),
    note: CORRECT_IN_CRM,
  },
  {
    key: "unit_model", label: "Model", group: "Vehicle", provider_property: "model",
    resolve: (s) => fromCrm(text(s.unit_model)),
    note: CORRECT_IN_CRM,
  },
  {
    key: "condition", label: "New or Used", group: "Vehicle", provider_property: "new.used",
    resolve: (s) => fromCrm(conditionLabel(s.condition)),
    note: CORRECT_IN_CRM,
  },
  {
    key: "vehicle_type_code", label: "Vehicle type", group: "Vehicle", provider_property: null,
    resolve: (s) => {
      const mapped = text(s.vehicle_type_code);
      if (mapped !== null) return { value: mapped, source: "CRM" };
      // The decode's own opinion, when our body-type mapping had none. Better
      // than nothing and clearly attributed, so a staff member can see that the
      // vehicle type came from the provider rather than from the deal.
      const auto = decoded(s, "vtype");
      if (auto !== null) return { value: auto, source: "VIN Decode" };
      return { value: null, source: "Missing" };
    },
    note: "Mapped from the deal's body type. Decides which fields TecAssured asks for.",
  },
  {
    key: STAFF_ENTERED.engineCc, label: "Engine size (cc)", group: "Vehicle",
    provider_property: "engine.ccs",
    resolve: (s) => staffThenDecode(s, STAFF_ENTERED.engineCc, "displacement"),
    editable: true,
    note: "From the VIN decode where it answers. Type it to correct it.",
  },
  {
    key: "odometer", label: "Odometer", group: "Vehicle", provider_property: "odometer",
    resolve: (s) => fromCrm(text(s.odometer)),
    note: CORRECT_IN_CRM,
  },
  {
    key: "in_service_date", label: "In-service date", group: "Vehicle",
    provider_property: "inservice.date",
    resolve: (s) => fromCrm(text(s.in_service_date) ?? text(s.sale_date)),
    note: "Defaults to the sale date. " + CORRECT_IN_CRM,
  },
  {
    key: STAFF_ENTERED.warrantyMonths, label: "Factory warranty remaining (months)",
    group: "Vehicle", provider_property: "warranty",
    resolve: (s) => {
      const typed = staffValue(s, STAFF_ENTERED.warrantyMonths);
      return typed !== null
        ? { value: typed, source: "Entered by Staff" as FieldSource }
        : { value: null, source: "Missing" as FieldSource };
    },
    editable: true,
    note:
      "No system carries this. Not in CRM, not in DX1, and the VIN decode does " +
      "not return it. Someone has to read it off the machine's coverage.",
  },
  {
    key: "fuel.type", label: "Fuel type", group: "Vehicle", provider_property: "fuel.type",
    resolve: (s) => staffThenDecode(s, "fuel.type", "fuelType"),
    editable: true,
    note: "From the VIN decode. G is gasoline, E electric, D diesel.",
  },

  // ── Money ──────────────────────────────────────────────────────────────
  {
    key: "sale_price", label: "Sale price", group: "Money", provider_property: "price",
    resolve: (s) => fromCrm(money(s.sale_price)),
    note: CORRECT_IN_CRM,
  },
  {
    key: "amount_financed", label: "Amount financed", group: "Money",
    provider_property: "finance.amount",
    resolve: (s) =>
      // A cash deal finances nothing, and that is a fact rather than a gap. The
      // rate builder sends zero for the same reason; saying "Missing" here
      // would send a person looking in CRM for a number that should not exist.
      dealTypeLabel(s.finance_type) === "Cash"
        ? { value: money(0), source: "CRM" }
        : fromCrm(money(s.amount_financed)),
    note: "Zero on a cash deal. " + CORRECT_IN_CRM,
  },
  {
    key: "finance_term", label: "Term (months)", group: "Money",
    provider_property: "finance.term",
    resolve: (s) =>
      dealTypeLabel(s.finance_type) === "Cash"
        ? { value: "0", source: "CRM" }
        : fromCrm(text(s.finance_term)),
    note: "Zero on a cash deal. " + CORRECT_IN_CRM,
  },
  {
    key: "apr", label: "APR", group: "Money", provider_property: "finance.apr",
    resolve: (s) => {
      if (dealTypeLabel(s.finance_type) === "Cash") return { value: "0%", source: "CRM" };
      const v = text(s.apr);
      return v === null ? { value: null, source: "Missing" } : { value: `${v}%`, source: "CRM" };
    },
    note: "Zero on a cash deal. " + CORRECT_IN_CRM,
  },

  // ── Customer ───────────────────────────────────────────────────────────
  // City, state and ZIP only. Nothing on this screen needs the customer's name,
  // street, phone or email to check a rate, and a staff screen that shows them
  // is a staff screen that leaks them.
  {
    key: "buyer_city", label: "City", group: "Customer", provider_property: null,
    resolve: (s) => fromCrm(text(s.buyer_city)),
    note: CORRECT_IN_CRM,
  },
  {
    key: "buyer_state", label: "State", group: "Customer", provider_property: null,
    resolve: (s) => fromCrm(text(s.buyer_state)),
    note: CORRECT_IN_CRM,
  },
  {
    key: "buyer_zip", label: "ZIP", group: "Customer", provider_property: "postal.code",
    resolve: (s) => fromCrm(text(s.buyer_zip)),
    note: CORRECT_IN_CRM,
  },
];

/**
 * Build the sheet.
 *
 * `requiredProperties` is what /rate/requiredproperties returned for this
 * store and vehicle type, in its own spelling. A field is required when its
 * provider property is in that list, compared case-insensitively because
 * TecAssured returns `warranty` for ATV and `Warranty` for UTV.
 *
 * With no list -- the vehicle type is unmapped, or the cache is cold -- nothing
 * is marked required and `ready` is false. That is deliberate: we do not know
 * what is needed, and a screen that says ready while not knowing is worse than
 * one that says wait.
 */
export function buildVerification(
  src: VerificationSource,
  requiredProperties: string[]
): VerificationSheet {
  const wanted = new Set(requiredProperties.map((p) => p.toLowerCase()));

  const fields: VerifyField[] = SPECS.map((spec) => {
    const { value, source } = spec.resolve(src);
    const required =
      spec.provider_property !== null && wanted.has(spec.provider_property.toLowerCase());

    return {
      key: spec.key,
      label: spec.label,
      group: spec.group,
      value,
      source,
      editable: spec.editable === true,
      provider_property: spec.provider_property,
      required,
      missing: required && value === null,
      note: spec.note ?? null,
    };
  });

  // Every property TecAssured asked for that no field on this sheet answers.
  const answered = new Set(
    SPECS.map((s) => s.provider_property?.toLowerCase()).filter(
      (p): p is string => p !== undefined && p !== null
    )
  );
  const unmapped_properties = requiredProperties.filter(
    (p) => !answered.has(p.toLowerCase())
  );

  const missing = fields.filter((f) => f.missing);

  return {
    fields,
    missing,
    // An unmapped property is a field the screen cannot show, so it cannot be
    // filled in, so this is not ready however complete the sheet looks.
    ready:
      requiredProperties.length > 0 &&
      missing.length === 0 &&
      unmapped_properties.length === 0,
    unmapped_properties,
  };
}

// ── Has anything that matters changed? ────────────────────────────────────

/**
 * The rating inputs, flattened, for comparing a refreshed deal against what was
 * verified.
 *
 * Only fields that feed the rate request: a corrected stock number does not
 * invalidate a price, and sending a verifier back through the screen for one
 * would teach them to click through it. Values are compared as the sheet shows
 * them, so a formatting change alone cannot trip it.
 */
export function ratingInputs(sheet: VerificationSheet): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of sheet.fields) {
    if (f.provider_property !== null) out[f.key] = f.value;
  }
  return out;
}

/** Which rating inputs differ between two sheets. Empty means nothing moved. */
export function changedInputs(
  before: Record<string, string | null> | null | undefined,
  after: Record<string, string | null>
): string[] {
  if (!before) return Object.keys(after);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => (before[k] ?? null) !== (after[k] ?? null)).sort();
}
