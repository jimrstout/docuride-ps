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
//   CRM               From the Zoho deal, and untouched since. The deal is still
//                     the record; an edit here does not change it, it sits over
//                     it and says so.
//   DX1               From the DMS. Photos only today; no rating input comes
//                     from it. Named anyway, because it is a source staff know
//                     and its absence from this list is itself informative.
//   VIN Decode        From TecAssured's own /decode/ps. Engine size, fuel type,
//                     and its opinion of the vehicle type.
//   Entered by Staff  Typed on this screen, for a field no system carries.
//   Edited by Staff   Typed on this screen, OVER a value another source gave.
//                     Always shown beside the original and its source.
//   Missing           No value from anywhere.
//
// ── Every rating input is editable (2026-09-27) ───────────────────────────
// The CRM fields used to be read-only here, with a note telling whoever was
// looking to go and correct the deal in Zoho. That was right about ownership and
// wrong about the room: a person holding the machine's papers could see a wrong
// odometer on the screen and not fix it, so either the rate went out wrong or the
// deal waited on somebody else's data entry.
//
// So every field that feeds a rate is editable now. What keeps it honest is that
// nothing is hidden: an edited field shows what it was and where that came from,
// the edit carries the name of whoever made it, and a warning names every value
// that no longer matches the deal until the deal is brought into line. Three
// fields stay read-only: Deal # and Stock #, because they are not rating inputs
// and renaming a deal on this screen would only make it harder to tell which
// deal you are on, and Lender, which is shown so staff can confirm who is
// financing it while deal type above is the field that decides how it rates.

import { financeFigures, type FinanceSource } from "./finance-basis.ts";
import { resolveFuelType } from "./fuel-type.ts";
import { resolveEngineCc } from "./engine-size.ts";
import {
  EDITED_SOURCE,
  applyStaffEdits,
  castForColumn,
  crmMismatchWarning,
  editTargetFor,
  type CrmMismatch,
  type StaffEdits,
} from "./staff-edits.ts";

// Re-exported so a caller that already holds the sheet does not need a second
// import for it. The table itself lives in staff-edits.ts, because where an edit
// lands is not a display question.
export { editTargetFor };

/** Where a value came from. Human-readable, because it is shown as written. */
export type FieldSource =
  | "CRM"
  | "DX1"
  | "VIN Decode"
  | "Entered by Staff"
  | "Edited by Staff"
  // A value nobody supplied and nobody checked, filled in so the deal can still
  // be rated. Today only fuel type, which defaults to Gasoline. It is not
  // Missing and does not block Confirm; it says the value was not checked.
  | "Default"
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
  /**
   * Staff may type it here. True for every rating input, and false for exactly
   * three -- Deal #, Stock # and Lender -- plus the three finance figures on a
   * cash deal.
   */
  editable: boolean;
  /** The TecAssured property this answers, when it answers one. */
  provider_property: string | null;
  /** requiredproperties named this for this vehicle type. */
  required: boolean;
  /** Required and empty. What the screen highlights and the gate counts. */
  missing: boolean;
  /** Shown under a read-only field, or as help under an editable one. */
  note: string | null;

  // ── The edit story, when there is one ──────────────────────────────────

  /** The value this one replaced, as the sheet showed it at the time. */
  original: string | null;
  /** Where that original came from. Null when the field was never edited. */
  original_source: FieldSource | null;
  /** The CRM deal also carries this field, so an edit to it can disagree. */
  in_crm: boolean;
  /**
   * Edited, and the CRM deal still says something else.
   *
   * Recomputed on every read against what CRM says NOW, not against the stored
   * original, which is what makes the warning go away by itself once the deal is
   * corrected and refreshed.
   */
  differs_from_crm: boolean;
  /** An edit that could not be read as a number or a date. Blocks Verify. */
  invalid: boolean;
  /** Who made the edit and when. Null when the field was never edited. */
  edited_by: string | null;
  edited_at: string | null;
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

  /** Every field a person has edited, in the order they appear on the sheet. */
  edited: VerifyField[];
  /** Edited fields whose value the CRM deal does not agree with. */
  crm_mismatches: CrmMismatch[];
  /** The one warning shown above Verify, or null when there is nothing to say. */
  crm_warning: string | null;
  /** An edit that could not be read. Verify is refused while any exists. */
  invalid: VerifyField[];
  /**
   * Set when the finance company's maximum is known and the amount financed is
   * already over it, before any protection products. A warning only: it does
   * not block Verify.
   */
  over_cap_warning: string | null;
}

const FROM_CRM = "From the CRM deal. Edit it here to correct the rate.";

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

  // ── The finance figures the planner reads ─────────────────────────────────
  // Not duplicates of the three above. SPEC_CORRECTIONS.md §1 settled which
  // columns carry a deal's real term, rate and principal against an actual
  // contract, and these are they. The sheet resolves through
  // _shared/finance-basis.ts so this screen and the customer's screen cannot
  // disagree about the term of the same loan. Deal 13759 is why: it showed
  // "6.99% · 60 months" to the customer and "Missing" to staff.
  interest_rate: unknown;
  finance_term_total: unknown;
  tila_amount_financed: unknown;
  lienholder_name: unknown;
  /** The down payment agreed on the deal, from Sold_1_Down_Payment. */
  agreed_down_payment?: unknown;
  /** The finance company's maximum, typed on Verify. The CRM does not carry it. */
  max_amount_financed?: unknown;

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
  // Where an edit lands is NOT declared here. It comes from EDIT_TARGETS in
  // _shared/staff-edits.ts, keyed on this spec's own key, so the screen and the
  // rate builder cannot end up with two answers. A key absent from that table is
  // a field nobody may edit: Deal #, Stock # and Lender, and nothing else.
  /** The CRM deal carries this too, so an edit can disagree with the deal. */
  in_crm?: boolean;
  /**
   * Editable only when this holds.
   *
   * Used by the three finance figures. On a cash deal they are not unknowns to
   * be filled in, they are the deal's arithmetic: zero financed over zero months
   * at zero percent. Letting somebody type $19,000 into a cash deal is how 14132
   * would have told the provider a cash buyer financed twenty thousand dollars.
   * Change the deal type first and they open up.
   */
  editableWhen?: (src: VerificationSource) => boolean;
  /**
   * Editable, but stored in its own session column rather than through the
   * staff edit layer, because nothing else supplies it. Never a rating input.
   * Today only the maximum amount financed. See fni-session-verify save().
   */
  staff_column?: boolean;
  /** Left off the sheet entirely unless this holds. */
  shownWhen?: (src: VerificationSource) => boolean;
  /**
   * Help text under the field. A function where the right thing to say depends
   * on the deal: the three finance figures used to explain, on every deal, that
   * they read zero on a cash purchase -- which is confusing to the point of
   * being wrong when you are looking at a financed one.
   */
  note?: string | null | ((src: VerificationSource) => string | null);
}

/**
 * A financed deal: a lienholder is attached, and the deal type has not been
 * corrected to Cash. The maximum amount financed means nothing otherwise.
 */
const FINANCED_WITH_LENDER = (s: VerificationSource) =>
  text(s.lienholder_name) !== null && dealTypeLabel(s.finance_type) !== "Cash";

const NOT_ON_A_CASH_DEAL = (s: VerificationSource) =>
  dealTypeLabel(s.finance_type) !== "Cash";

/**
 * Said only on a cash deal.
 *
 * It used to be said on every deal, because it was a plain string. On deal 13759
 * -- financed, 60 months at 6.99% -- the screen explained underneath each of the
 * three finance figures that they were zero because this was a cash purchase.
 */
function cashNote(src: VerificationSource): string | null {
  return dealTypeLabel(src.finance_type) === "Cash"
    ? "Zero on a cash deal, which is the deal's arithmetic rather than a gap. " +
      "Change the deal type to edit it."
    : FROM_CRM;
}

/** The resolved figures for one session. */
function figuresFor(src: VerificationSource) {
  return financeFigures(src as unknown as FinanceSource);
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
 *
 * Engine size is resolved in _shared/engine-size.ts, the same function the rate
 * request calls, so a decoded size shown here is the size that is sent.
 */
function engineCc(src: VerificationSource): { value: string | null; source: FieldSource } {
  return resolveEngineCc(src.vehicle_properties, src.vin_decode) ??
    { value: null, source: "Missing" };
}

const SPECS: Spec[] = [
  // ── Deal ───────────────────────────────────────────────────────────────
  //
  // The two identifiers are not editable. They are not rating inputs, and their
  // whole job is to let a person confirm which deal they are looking at -- which
  // editing them here would defeat. Lender below is read-only for its own
  // reason: deal type is what decides how the deal rates.
  {
    key: "deal_number", label: "Deal #", group: "Deal", provider_property: null,
    resolve: (s) => fromCrm(text(s.deal_number)),
    in_crm: true,
    note: "Identifies the deal, so it is not editable here. Correct it in CRM.",
  },
  {
    key: "stock_number", label: "Stock #", group: "Deal", provider_property: null,
    resolve: (s) => fromCrm(text(s.stock_number)),
    in_crm: true,
    note: "Identifies the unit, so it is not editable here. Correct it in CRM.",
  },
  {
    key: "deal_type", label: "Deal type", group: "Deal", provider_property: "finance.type",
    resolve: (s) => fromCrm(dealTypeLabel(s.finance_type)),
    in_crm: true,
    note: "Cash, Finance or Lease. Changing it opens or closes the finance figures below.",
  },
  {
    key: "sale_date", label: "Sale date", group: "Deal", provider_property: "sale.date",
    resolve: (s) => fromCrm(text(s.sale_date)),
    in_crm: true,
    note: FROM_CRM,
  },

  // ── Vehicle ────────────────────────────────────────────────────────────
  {
    key: "vin", label: "VIN", group: "Vehicle", provider_property: "vin",
    resolve: (s) => fromCrm(text(s.vin)),
    in_crm: true,
    note: FROM_CRM,
  },
  {
    key: "unit_year", label: "Year", group: "Vehicle", provider_property: "year",
    resolve: (s) => fromCrm(text(s.unit_year)),
    in_crm: true,
    note: FROM_CRM,
  },
  {
    key: "unit_make", label: "Make", group: "Vehicle", provider_property: "make",
    resolve: (s) => fromCrm(text(s.unit_make)),
    in_crm: true,
    note: FROM_CRM,
  },
  {
    key: "unit_model", label: "Model", group: "Vehicle", provider_property: "model",
    resolve: (s) => fromCrm(text(s.unit_model)),
    in_crm: true,
    note: FROM_CRM,
  },
  {
    key: "condition", label: "New or Used", group: "Vehicle", provider_property: "new.used",
    resolve: (s) => fromCrm(conditionLabel(s.condition)),
    in_crm: true,
    note: "New or Used. " + FROM_CRM,
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
    in_crm: true,
    note:
      "Mapped from the deal's body type, and it decides which fields TecAssured " +
      "asks for. UTV, ATV, MCYC, BIKE, PWAC, BOAT or SNOW.",
  },
  {
    key: STAFF_ENTERED.engineCc, label: "Engine size (cc)", group: "Vehicle",
    provider_property: "engine.ccs",
    resolve: engineCc,
    note:
      "From the VIN decode where it answers. The CRM does not carry it, so " +
      "typing it here raises no warning.",
  },
  {
    key: "odometer", label: "Odometer", group: "Vehicle", provider_property: "odometer",
    resolve: (s) => fromCrm(text(s.odometer)),
    in_crm: true,
    note: FROM_CRM,
  },
  {
    key: "in_service_date", label: "In-service date", group: "Vehicle",
    provider_property: "inservice.date",
    resolve: (s) => fromCrm(text(s.in_service_date) ?? text(s.sale_date)),
    in_crm: true,
    note: "Defaults to the sale date. " + FROM_CRM,
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
    note:
      "No system carries this. Not in CRM, not in DX1, and the VIN decode does " +
      "not return it. Someone has to read it off the machine's coverage.",
  },
  {
    key: "fuel.type", label: "Fuel type", group: "Vehicle", provider_property: "fuel.type",
    // The same resolution the rate request uses, so the sheet and the request
    // cannot disagree. See _shared/fuel-type.ts.
    resolve: (s) => resolveFuelType(s.vehicle_properties, s.vin_decode),
    note:
      "From the VIN decode, or Gasoline by default when nothing else says. " +
      "Choose Electric or Diesel if that is what it is.",
  },

  // ── Money ──────────────────────────────────────────────────────────────
  // Shown under the heading Financial. Lender comes first: it says whether
  // there is a loan at all, which is what every row below it depends on.
  {
    key: "lender", label: "Lender", group: "Money", provider_property: null,
    // Read from the same field the planner and the acknowledgment PDF read, so
    // all three agree about who is financing this deal. Not a TecAssured rating
    // input and not editable here: deal type is the field that decides how this
    // deal rates, and it is editable two rows up. Attach or correct a lienholder
    // in CRM.
    resolve: (s) => {
      const fig = figuresFor(s);
      // A cash purchase has no lender, which is a fact rather than a gap.
      if (!fig.financed) return { value: "None (cash deal)", source: "CRM" };
      return fromCrm(fig.lenderName);
    },
    in_crm: true,
    note:
      "From the CRM deal, and what the customer's screen shows. Deal type is " +
      "what the rate uses. Attach a lienholder in CRM to change this.",
  },
  {
    key: "agreed_down_payment", label: "Down payment", group: "Money", provider_property: null,
    // Read only, and not a rating input: TecAssured does not ask for it. From
    // Sold_1_Down_Payment through _shared/crm-fields.ts, so creation, reopen and
    // Refresh all fill it the same way.
    resolve: (s) => fromCrm(money(s.agreed_down_payment)),
    in_crm: true,
    note: "The down payment agreed on the deal, before any protection products.",
  },
  {
    key: "max_amount_financed", label: "Maximum amount financed", group: "Money",
    provider_property: null,
    // The finance company's approval is its only source, so it is typed here.
    // Not required, and not a rating input: saving it never marks rates out of
    // date or resets verification.
    resolve: (s) => {
      const v = money(s.max_amount_financed);
      return { value: v, source: (v === null ? "Missing" : "Entered by Staff") as FieldSource };
    },
    staff_column: true,
    shownWhen: FINANCED_WITH_LENDER,
    editableWhen: FINANCED_WITH_LENDER,
    note:
      "From the finance company's approval. Leave blank if the approval has no maximum.",
  },
  {
    key: "sale_price", label: "Sale price", group: "Money", provider_property: "price",
    resolve: (s) => fromCrm(money(s.sale_price)),
    in_crm: true,
    note: FROM_CRM,
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
    in_crm: true,
    editableWhen: NOT_ON_A_CASH_DEAL,
    note: cashNote,
  },
  {
    key: "finance_term", label: "Term (months)", group: "Money",
    provider_property: "finance.term",
    resolve: (s) => {
      if (dealTypeLabel(s.finance_type) === "Cash") return { value: "0", source: "CRM" };
      // The resolved term, not sessions.finance_term. Same source the planner
      // reads, so the two screens agree about the same loan.
      const term = figuresFor(s).termMonths;
      return term === null
        ? { value: null, source: "Missing" }
        : { value: String(term), source: "CRM" };
    },
    in_crm: true,
    editableWhen: NOT_ON_A_CASH_DEAL,
    note: cashNote,
  },
  {
    key: "apr", label: "APR", group: "Money", provider_property: "finance.apr",
    resolve: (s) => {
      if (dealTypeLabel(s.finance_type) === "Cash") return { value: "0%", source: "CRM" };
      // APR where TILA was calculated, the deal's interest rate otherwise. The
      // label says which, so nobody has to guess whether 6.99% is an APR.
      const fig = figuresFor(s);
      return fig.ratePercent === null
        ? { value: null, source: "Missing" }
        : { value: `${fig.ratePercent}%`, source: "CRM" };
    },
    in_crm: true,
    editableWhen: NOT_ON_A_CASH_DEAL,
    note: (s) => {
      if (dealTypeLabel(s.finance_type) === "Cash") return cashNote(s);
      const fig = figuresFor(s);
      return fig.rateLabel === null
        ? FROM_CRM
        : `${fig.rateLabel} on this deal. ${FROM_CRM}`;
    },
  },

  // ── Customer ───────────────────────────────────────────────────────────
  // City, state and ZIP only. Nothing on this screen needs the customer's name,
  // street, phone or email to check a rate, and a staff screen that shows them
  // is a staff screen that leaks them. All three reach the rate request, so all
  // three are editable.
  {
    key: "buyer_city", label: "City", group: "Customer", provider_property: null,
    resolve: (s) => fromCrm(text(s.buyer_city)),
    in_crm: true,
    note: FROM_CRM,
  },
  {
    key: "buyer_state", label: "State", group: "Customer", provider_property: null,
    resolve: (s) => fromCrm(text(s.buyer_state)),
    in_crm: true,
    note: FROM_CRM,
  },
  {
    key: "buyer_zip", label: "ZIP", group: "Customer", provider_property: "postal.code",
    resolve: (s) => fromCrm(text(s.buyer_zip)),
    in_crm: true,
    note: FROM_CRM,
  },
];

/** Field keys a staff member may edit on this screen, given the current deal. */
export function editableKeys(src: VerificationSource): string[] {
  return SPECS.filter(
    (s) =>
      (editTargetFor(s.key) !== null || s.staff_column === true) &&
      (s.editableWhen ? s.editableWhen(src) : true)
  ).map((s) => s.key);
}

/** The label a field key reads as, for a message that names it. */
export function labelFor(key: string): string {
  return SPECS.find((s) => s.key === key)?.label ?? key;
}

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
  requiredProperties: string[],
  edits: StaffEdits = {}
): VerificationSheet {
  const wanted = new Set(requiredProperties.map((p) => p.toLowerCase()));

  // Two passes over the same specs, and that is the whole trick.
  //
  // `src` is the session as its sources left it: the CRM's figures, the decode's,
  // and the fields only a person can supply. `edited` is the same row with the
  // staff layer applied. Resolving each field against both means the "was" and
  // the "now" have been through the identical formatter, so $24,000.00 is
  // compared with $25,500.00 rather than with the string "25500" -- which is
  // what makes "does this still differ from CRM" answerable at all.
  const editedSrc = applyStaffEdits(
    src as unknown as Record<string, unknown>,
    edits,
    editTargetFor
  ) as unknown as VerificationSource;

  const fields: VerifyField[] = SPECS.filter(
    (spec) => (spec.shownWhen ? spec.shownWhen(editedSrc) : true)
  ).map((spec) => {
    const asSourced = spec.resolve(src);
    const target = editTargetFor(spec.key);
    const edit = target === null ? undefined : edits[spec.key];

    // An edit that will not cast is not applied, so the column still holds the
    // CRM value. Reported rather than swallowed: somebody typed a correction and
    // it is not in force, which the gate must refuse rather than rate around.
    const invalid =
      edit !== undefined &&
      target !== null &&
      target.kind === "column" &&
      castForColumn(target, edit.value) === null;

    // ── Always resolved against the corrected deal ───────────────────────────
    // This used to resolve against `editedSrc` only for a field that had been
    // edited itself, and against the raw row otherwise. So an edit to one field
    // could not reach another: correcting a deal from Cash to Finance left Term
    // reading "0" and Amount financed reading "$0.00", because those two specs
    // branch on the deal type and were still being handed the uncorrected row.
    // Worse, `editable` was already computed from the corrected deal, so the
    // screen opened the boxes and then showed cash-deal zeroes in them.
    //
    // An un-castable edit needs no special case: applyStaffEdits does not apply
    // one, so editedSrc still holds the value its source gave.
    const shown = spec.resolve(editedSrc);

    const required =
      spec.provider_property !== null && wanted.has(spec.provider_property.toLowerCase());

    const editable =
      (target !== null || spec.staff_column === true) &&
      (spec.editableWhen ? spec.editableWhen(editedSrc) : true);

    const in_crm = spec.in_crm === true;

    return {
      key: spec.key,
      label: spec.label,
      group: spec.group,
      value: shown.value,
      // An edit over a value something else supplied reads differently from a
      // field only a person could fill in, and the screen shows the difference.
      source: edit !== undefined
        ? (asSourced.source === "Missing" || asSourced.source === "Default"
            ? "Entered by Staff"
            : EDITED_SOURCE)
        : shown.source,
      editable,
      provider_property: spec.provider_property,
      required,
      missing: required && shown.value === null,
      note: typeof spec.note === "function" ? spec.note(editedSrc) : (spec.note ?? null),

      original: edit !== undefined ? asSourced.value : null,
      original_source: edit !== undefined ? asSourced.source : null,
      in_crm,
      // Against what CRM says NOW, not against the stored original. That is what
      // lets the warning clear itself once the deal is corrected and refreshed.
      differs_from_crm:
        edit !== undefined && in_crm && !invalid && shown.value !== asSourced.value,
      invalid,
      edited_by: edit?.edited_by ?? null,
      edited_at: edit?.edited_at ?? null,
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
  const edited = fields.filter((f) => f.original_source !== null);
  const invalid = fields.filter((f) => f.invalid);

  const crm_mismatches: CrmMismatch[] = fields
    .filter((f) => f.differs_from_crm)
    .map((f) => ({
      key: f.key,
      label: f.label,
      crm_value: f.original,
      edited_value: f.value,
      edited_by: f.edited_by ?? "unknown",
      edited_at: f.edited_at ?? "",
    }));

  return {
    fields,
    missing,
    // An unmapped property is a field the screen cannot show, so it cannot be
    // filled in, so this is not ready however complete the sheet looks. An edit
    // that could not be read blocks it too: the person's correction is not in
    // force, and rating past that would quote the figure they just rejected.
    //
    // A field that merely disagrees with CRM does NOT block. Jim's rule: staff
    // can still verify, and the warning stays up until the deal matches.
    ready:
      requiredProperties.length > 0 &&
      missing.length === 0 &&
      unmapped_properties.length === 0 &&
      invalid.length === 0,
    unmapped_properties,
    edited,
    crm_mismatches,
    crm_warning: crmMismatchWarning(crm_mismatches),
    invalid,
    over_cap_warning: overCapWarning(editedSrc),
  };
}

/** A money value as whole cents, or null. Cents, so a penny is never lost. */
function cents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * The amount financed is already over the finance company's maximum.
 *
 * Only on a financed deal with a maximum set, and measured against the Amount
 * financed the sheet shows, with any staff correction applied. A warning: it
 * says the plan has no room before any product is added, and does not block.
 */
export function overCapWarning(src: VerificationSource): string | null {
  if (!FINANCED_WITH_LENDER(src)) return null;
  const cap = cents(src.max_amount_financed);
  const financed = cents(src.amount_financed);
  if (cap === null || financed === null || financed <= cap) return null;
  return (
    `The amount financed is already ${money((financed - cap) / 100)} over the ` +
    `maximum from the finance company, before any protection products.`
  );
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
    // A field feeds the rate if TecAssured named it, or if it is editable here.
    // The second half catches three that reach the request without appearing in
    // requiredproperties: the vehicle type, which decides what is asked for at
    // all, and the customer's city and state, which go up as customerCity and
    // customerState. Deal #, Stock # and Lender have neither, and are the only
    // fields on the sheet a change to cannot alter a price.
    // Keyed off the spec's target rather than f.editable, so the cash-deal
    // toggle on the three finance figures cannot quietly drop a field out of the
    // comparison the verification gate depends on.
    if (f.provider_property !== null || editTargetFor(f.key) !== null) {
      out[f.key] = f.value;
    }
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
