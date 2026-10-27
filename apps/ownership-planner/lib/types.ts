// lib/types.ts — the shape fni-session-get returns.

export type Disposition = "Included" | "Managed by Customer";

/** Title case, matching every other constrained column on fni.sessions. */
export type SessionMode = "Self-Guided" | "Collaborative" | "Staff-Presented";

export interface SurchargeOption {
  code: string;
  label: string;
  /** Can be negative. GPS EQUIPPED takes 50 off theft cover. */
  cost_delta: number;
  /** Not a choice: it rides along whether or not the customer ticks it. */
  mandatory: boolean;
  applied: boolean;
}

/**
 * One buyable combination of length, deductible and price.
 *
 * A product has several. USED ATV/UTV CARE comes back with twelve, being four
 * lengths times three deductibles, and which one the customer takes changes both
 * the cover and the price. The old shape assumed one price per product, which
 * was wrong for every product but the single-rate ones.
 */
export interface OfferRate {
  rate_unique_id: string;
  term_months: number | null;
  /** 0 on every powersports rate. Omitted from the interface when falsy. */
  term_miles: number | null;
  deductible: number | null;
  /** The provider's own words: "0 Ded", "100 Dis Ded". */
  deductible_code: string | null;
  disappearing_deductible: boolean;
  dealer_cost: number | null;
  provider_markup: number;
  /** dealer_cost + provider_markup. The provider refuses a submit above it. */
  offered_price: number | null;
  options: SurchargeOption[];
  /** null when no pricing band covers the cost. Such a rate is not sellable. */
  retail_price: number | null;
  pricing_rule_id: string | null;
  unpriced_reason: string | null;
  raw: Record<string, unknown>;
}

/** One product: a tier within its family. */
export interface OfferTier {
  product_code: string;
  product_name: string;
  product_type: string;
  rates: OfferRate[];
  raw: Record<string, unknown>;
  /** Set when a menu slot puts two providers' products in one decision. */
  provider_id?: string | null;
  provider_name?: string | null;
}

/**
 * One decision for the customer: which tier of this family, or none.
 *
 * The quote offers eleven products and four of them are Platinum, Gold, Silver
 * and Bronze. They are tiers of one thing, so they are one screen and one
 * choice, not four include-or-decline questions that could be answered yes
 * four times.
 */
export interface OfferFamily {
  family_code: string;
  /** Who offered it, from fni.providers. */
  provider_id: string | null;
  provider_name: string | null;
  tiers: OfferTier[];
}

export interface CatalogEntry {
  /** Two providers may use one product code, so copy is keyed by both. */
  provider_id: string | null;
  category: string | null;
  product_code: string;
  display_name: string;
  goal: string;
  what_it_accomplishes: string | null;
  what_it_covers: string | null;
  coverage_duration: string | null;
  what_it_excludes: string | null;
  deductible_note: string | null;
  how_to_use: string | null;
  transferable: boolean | null;
  transfer_note: string | null;
  future_value_note: string | null;
  full_terms_url: string | null;
  /** Discovery answers this product is most relevant to. Reorders only. */
  relevance_tags: string[];
  display_order: number;
  store_id: string | null;
  is_presentable: boolean;
}

export interface Selection {
  provider_id: string | null;
  provider_product_id: string;
  disposition: Disposition;
  retail_price: string | number | null;
  term_months: number | null;
  /** Which rate of that product, so a resumed session reopens on the same one. */
  rate_unique_id: string | null;
  selected_options: unknown;
  presented_at: string | null;
}

export interface PlannerSession {
  id: string;
  status: string;
  mode: SessionMode | null;
  /** How the mode reads to a buyer. Derived by fni-session-get. */
  mode_label: string;
  store_id: string;
  deal_id: string | null;
  deal_number: string | null;
  buyer_type: string | null;
  buyer_display_name: string | null;
  cobuyer_type: string | null;
  cobuyer_display_name: string | null;
  vehicle: {
    year: number | null;
    make: string | null;
    model: string | null;
    submodel: string | null;
    vin: string | null;
    condition: string | null;
    tecassured_code: string | null;
    in_service_date: string | null;
    mileage_or_hours: number | null;
    stock_number: string | null;
  };
  financials: {
    sale_price: string | number | null;
    amount_financed: string | number | null;
    /** The lender's principal. This is what the payment is computed from. */
    amortized_principal: string | number | null;
    interest_rate: string | number | null;
    apr: string | number | null;
    rate_used: number | null;
    rate_source: "apr" | "interest_rate" | null;
    /** "Annual percentage rate" or "Interest rate". Never print one over the other's value. */
    rate_label: string | null;
    term_months: number | null;
    contract_payment: string | number | null;
    finance_type: string | null;
    lienholder_name: string | null;
    /**
     * Which tier supplied the payment inputs. `cash` is a deal with no
     * lienholder: it has no payment at all, and every monthly figure in the
     * interface is gated on `has_payment` because of it.
     */
    payment_basis: "tila" | "lienholder" | "cash" | "unavailable";
    has_payment: boolean;
    /**
     * The finance company's maximum amount financed. Anything past it is paid
     * at signing instead of financed. Null on a cash deal, or when no maximum
     * was given. Used in the arithmetic only; never shown to the customer.
     */
    max_amount_financed: number | null;
    /** The down payment agreed on the deal, from the CRM. */
    agreed_down_payment: number | null;
  };
  discovery: DiscoveryAnswers | null;
  expires_at: string | null;
}

export interface DiscoveryAnswers {
  use_context?: string[];
  [k: string]: unknown;
}

/**
 * Whether each rated product found its copy.
 *
 * `copy_pending` is a decision: a catalog row exists and its plain-language
 * copy is not written yet, so the product is withheld. `unmatched` is a
 * defect: the product was rated and nothing in fni.product_catalog matches it.
 * Before these were separated, both ended as a silent absence.
 */
export interface CatalogCoverage {
  offered: number;
  matched: number;
  copy_pending: { product_code: string; display_name: string }[];
  unmatched: { product_code: string; product_name: string }[];
}

export interface SessionPayload {
  session: PlannerSession;
  offer: {
    rated_at: string;
    product_count: number;
    families: OfferFamily[];
  } | null;

  /**
   * Why there is no menu, when there is no menu.
   *
   * The planner shows "plans aren't offered on this machine" ONLY for
   * "Not Offered". Every other state gets neutral copy, because the customer's
   * machine is not the reason.
   *
   * `detail` is written for staff and is stripped by the server layer before
   * this payload reaches the browser, so it is always null on the client.
   */
  offer_status: {
    state: "Rated" | "Not Offered" | "Failed" | "Pending" | "Superseded";
    detail: string | null;
    attempted_at: string | null;
  } | null;

  /**
   * Whether a person has checked the inputs a rate would be built from.
   *
   * The planner asks for its own rate and must not do so on an unverified deal.
   * Only the state crosses to the browser; who verified it and what they saw
   * live on the staff screen.
   */
  verification: {
    state: "Needs Verification" | "Verified";
    verified_at: string | null;
  } | null;
  catalog: CatalogEntry[];
  /** The dealer group as a buyer reads it. Null means no name is set. */
  dealer_group_name: string | null;
  /** Customer-facing sentences with {placeholder} names still in them. */
  copy: Record<string, string>;
  catalog_coverage: CatalogCoverage;
  selections: Selection[];
  photos: string[] | null;
  photos_cached_at: string | null;
}

/** Postgres numerics arrive as strings over PostgREST. */
export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ── The internal console ──────────────────────────────────────────────────
// What fni-admin-sessions returns. Deliberately narrow: no buyer, co-buyer,
// lienholder or VIN field appears here because the Edge Function never sends
// one, and this type is the record of that.

export interface ConsoleSessionRow {
  id: string;
  deal_number: string | null;
  status: string | null;
  mode: SessionMode | null;
  store_name: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  submodel: string | null;
  stock_number: string | null;
  created_at: string;
  expires_at: string;
  /** Decided by the Edge Function against one clock, never recomputed here. */
  expired: boolean;

  /**
   * What happened the last time this session's menu was asked for.
   *
   * Staff-only. `detail` is the provider's refusal or the field that is
   * missing, and it is the answer to "the planner says plans aren't offered" --
   * which the customer's own screen deliberately will not tell them.
   */
  rating: {
    state: "Rated" | "Not Offered" | "Failed" | "Pending";
    detail: string | null;
    at: string | null;
    /** Each failed provider's exact text, for "Show details" (lib/rating-error.ts). */
    failures?: { provider: string; text: string; at: string | null }[];
  };
  /** The day the deal is planned to be sold, when staff set one on Details. */
  planned_sale_date?: string | null;
  /** Renew for Today would give the session longer: offered only then. */
  renewable?: boolean;
  /** What Renew for Today would set: 23:59:59 on the store's day. */
  renew_to?: string | null;
  /** The store's time zone, for showing that moment in the store's own time. */
  time_zone?: string | null;
}

export interface ConsoleListPayload {
  limit: number;
  as_of: string;
  sessions: ConsoleSessionRow[];
}

// ── Console settings ──────────────────────────────────────────────────────
// What fni-admin-settings returns. The dealer group's customer-facing name and
// the sentences that use it, which are rows rather than string literals so a
// wording change does not need a deploy.

export interface ConsoleTemplateRow {
  template_key: string;
  /** The wording in force: this tenant's own, or the platform default. */
  body: string | null;
  source: "Tenant" | "Platform default" | "Not set";
  platform_default: string | null;
  allowed_placeholders: string[];
  /** What a customer would read. Null means the line would be omitted. */
  preview: string | null;
  preview_uses_sample_amount: boolean;
}

export interface ConsoleSettingsPayload {
  tenant: {
    id: string;
    /** Administrative name. Never shown to a buyer. */
    name: string;
    dealer_group_display_name: string | null;
  };
  templates: ConsoleTemplateRow[];
  warnings?: string[];
}

// ── The Pricing section ───────────────────────────────────────────────────
// Worked out by fni-admin-settings with the planner's own pricing functions.
// The page only renders it.

export type PricingStoreStatus =
  | "Own rules"
  | "Uses All stores"
  | "No pricing: products will not be shown";

export interface PricingRuleRow {
  id: string;
  store_id: string | null;
  product_code: string | null;
  /** Display name of the product, or null for All products. */
  product_name: string | null;
  cost_floor: number;
  cost_ceiling: number;
  markup_percent: number;
  markup_min_dollars: number;
  markup_max_dollars: number | null;
  round_to: number;
  active: boolean;
  updated_at: string | null;
  updated_by: string | null;
  /** The rule in one plain sentence. */
  summary: string;
}

export interface PricingPreviewRow {
  cost: number;
  price: number | null;
  rule_id: string | null;
  rule_from: "This store" | "All stores" | null;
  rule_summary: string | null;
  reason: string | null;
}

export interface PricingPayload {
  stores: { id: string; name: string; status: PricingStoreStatus }[];
  /** How many active rules All stores has. */
  all_stores_active_rules: number;
  scope: { store_id: string | null; name: string };
  products: { code: string; name: string }[];
  rules: PricingRuleRow[];
  preview: {
    product_code: string | null;
    rows: PricingPreviewRow[];
    typed: PricingPreviewRow | null;
  };
  gaps: { from: number; to: number; sentence: string }[];
  copy_targets: { store_id: string | null; name: string; has_rules: boolean }[];
}

// ── The Verify step ───────────────────────────────────────────────────────
// Staff-facing. None of this is ever rendered to a customer.

export type FieldSource =
  | "CRM"
  | "DX1"
  | "VIN Decode"
  | "Entered by Staff"
  | "Edited by Staff"
  /** Filled in so the deal can be rated, and not checked by anyone. Today only
   *  fuel type, which defaults to Gasoline. Not Missing: it does not block. */
  | "Default"
  | "Missing";

export type FieldGroup = "Deal" | "Vehicle" | "Money" | "Customer";

export interface VerifyField {
  key: string;
  label: string;
  group: FieldGroup;
  value: string | null;
  source: FieldSource;
  editable: boolean;
  provider_property: string | null;
  required: boolean;
  missing: boolean;
  note: string | null;

  /** The value this one replaced, as the sheet showed it. Null if never edited. */
  original: string | null;
  original_source: FieldSource | null;
  /** The CRM deal carries this too, so an edit to it can disagree with the deal. */
  in_crm: boolean;
  /** Edited, and the CRM deal still says something else. */
  differs_from_crm: boolean;
  /** An edit that could not be read as a number or a date. Blocks Verify. */
  invalid: boolean;
  edited_by: string | null;
  edited_at: string | null;
}

export interface CrmMismatch {
  key: string;
  label: string;
  crm_value: string | null;
  edited_value: string | null;
  edited_by: string;
  edited_at: string;
}

export interface VerifySheet {
  session: {
    id: string;
    deal_number: string | null;
    stock_number: string | null;
    status: string | null;
    is_test: boolean;
    vehicle: string;
    deal_type: string | null;
    vehicle_type_code: string | null;
  };
  verification: {
    state: "Needs Verification" | "Verified";
    verified_at: string | null;
    verified_by: string | null;
  };
  rating: {
    state: "Rated" | "Not Offered" | "Failed" | "Pending";
    product_count: number;
    out_of_date: boolean;
    rated_at: string | null;
    detail: string | null;
    /** One line per provider the latest rating covered, in plain English. */
    providers?: {
      name: string;
      state: string;
      line: string;
      /** The provider's exact text when this attempt failed, and when. */
      error?: string | null;
      error_at?: string | null;
      /** Why the last re-rate failed when the earlier offers were kept. */
      kept_error?: string | null;
      kept_error_at?: string | null;
    }[];
  };
  /** The menu template this deal matches. Null when the dealer group has none. */
  menu_template?: { name: string } | null;
  /** Menu slots hidden from the customer on this deal, with why, for staff. */
  hidden_slots?: { title: string; note: string | null }[];
  /** The customer's OEM selections, whose contracts staff record here. */
  oem_contracts?: OemContractSelection[];
  /** The staff contracts panel. Null until the customer finishes the planner. */
  contracts_panel?: ContractsPanel | null;
  vin_decode: Record<string, unknown> | null;
  vin_decode_at: string | null;
  /** When a decode last started, successful or not. The page decodes on its
   *  own only while this and vin_decode_at are both null. */
  vin_decode_attempted_at: string | null;
  /** Why the last decode failed. Null after a success. */
  vin_decode_error: string | null;
  /** Another open session on this VIN. Null when there is none, which is the
   *  normal case: it is a warning, and it is never shown when there is nothing
   *  to warn about. */
  duplicate_vin: {
    message: string | null;
    sessions: { id: string; deal_number: string | null; status: string }[];
  } | null;
  /** Paperwork that already stands on this deal. Voided contracts are left out:
   *  they no longer hold a product's slot. */
  contracts: {
    contract_number: string | null;
    provider_product_id: string;
    product_name: string | null;
    status: string;
  }[];
  /** The submit lock. "Submit Status Unknown" blocks further submits until a
   *  person has checked TecAssured. */
  submit_state: "Idle" | "In Progress" | "Submit Status Unknown";
  submit_detail: string | null;
  /** Why nothing is required, when nothing is. Null when the sheet is normal. */
  not_ready_reason: string | null;
  fields: VerifyField[];
  missing: VerifyField[];
  ready: boolean;
  unmapped_properties: string[];
  /** Every field a person has edited, in the order they appear on the sheet. */
  edited: VerifyField[];
  /** Edited fields the CRM deal does not agree with. */
  crm_mismatches: CrmMismatch[];
  /** The warning shown above Verify, or null when there is nothing to say. */
  crm_warning: string | null;
  /** Edits that could not be read. Verify is refused while any exists. */
  invalid: VerifyField[];
  /** The amount financed is already over the finance company's maximum.
   *  A warning only; it does not block Confirm. */
  over_cap_warning: string | null;
  /** Present on a refresh response: the rating inputs the CRM moved. */
  changed_inputs?: string[];
  /** Present on a discard response: the edits that were thrown away. */
  discarded_edits?: string[];
}

// ── The admin area's Providers, Menus and Price sheets sections ─────────

export interface ProviderStoreRow {
  store_id: string;
  name: string;
  dealer_code: string | null;
  active: boolean;
}

export interface ProviderRow {
  id: string;
  name: string;
  kind: "Connected" | "Price Sheet";
  adapter: string | null;
  contract_method: "Through API" | "Recorded by Staff";
  makes: string[];
  active: boolean;
  notes: string | null;
  /** Starts the WorkDrive name of its documents ("TA"). Null when not set. */
  document_prefix: string | null;
  updated_at: string;
  updated_by: string | null;
  stores: ProviderStoreRow[];
  sheets: { name: string; status: string }[];
}

export interface ProvidersPayload {
  stores: { id: string; name: string }[];
  providers: ProviderRow[];
}

export interface TemplateSlotRow {
  id: string;
  template_id: string;
  position: number;
  title: string;
  category: string | null;
  mode: "Best Match" | "Side by Side";
  product_ids: string[];
}

export interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  store_ids: string[];
  deal_types: string[];
  vehicle_types: string[];
  conditions: string[];
  makes: string[];
  priority: number;
  active: boolean;
  updated_at: string;
  updated_by: string | null;
  conditions_line: string;
  slots: TemplateSlotRow[];
}

export interface CatalogProductRow {
  id: string;
  provider_id: string;
  provider_name: string;
  code: string;
  name: string;
  category: string;
  /** TecAssured's program name for this version. Staff only. */
  program: string | null;
}

export interface TemplatesPayload {
  stores: { id: string; name: string }[];
  products: CatalogProductRow[];
  vehicle_types: string[];
  templates: TemplateRow[];
}

export interface PriceSheetRow {
  id: string;
  provider_id: string;
  name: string;
  effective_from: string;
  effective_to: string | null;
  status: "Draft" | "Published" | "Retired";
  file_name: string;
  file_type: string;
  parse_status: "Not Parsed" | "Parsing" | "Parsed" | "Parse Failed";
  parse_notes: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  parse_seconds: number | string | null;
  parsed_at: string | null;
  uploaded_by: string;
  uploaded_at: string;
  published_by: string | null;
  published_at: string | null;
  retired_at: string | null;
  retired_reason: string | null;
}

export interface PriceSheetRateRow {
  id: string;
  product_code: string;
  product_name: string;
  family_code: string | null;
  plan: string | null;
  category: string | null;
  makes: string[];
  model_contains: string[];
  year_min: number | null;
  year_max: number | null;
  vehicle_types: string[];
  conditions: string[];
  max_age_years: number | null;
  max_odometer: number | null;
  engine_cc_min: number | null;
  engine_cc_max: number | null;
  max_months_in_service: number | null;
  term_months: number | null;
  term_miles: number | null;
  deductible: number | string | null;
  dealer_cost: number | string | null;
  suggested_retail: number | string | null;
  source_ref: string | null;
  confidence: "High" | "Medium" | "Low";
  model_note: string | null;
  flagged: boolean;
  flag_reason: string | null;
  left_out: boolean;
  left_out_reason: string | null;
  edited_by: string | null;
}


/** Providers, Product wording: one catalog product and its customer wording. */
export interface WordingProductRow {
  id: string;
  provider_id: string;
  product_code: string;
  display_name: string;
  category: string;
  goal: string;
  what_it_accomplishes: string | null;
  what_it_covers: string | null;
  coverage_duration: string | null;
  what_it_excludes: string | null;
  deductible_note: string | null;
  how_to_use: string | null;
  transferable: boolean | null;
  transfer_note: string | null;
  future_value_note: string | null;
  full_terms_url: string | null;
  active: boolean;
  updated_at: string;
  /** TecAssured's program name for this version. Staff only. */
  provider_program_name: string | null;
  /** What it still needs before the planner shows it. Empty when it is ready. */
  missing: string[];
}

/** A recorded OEM contract, as Verify lists it. */
export interface OemRecordedContract {
  contract_number: string;
  /** "Recorded" while it stands, "Voided" after. */
  state: string;
  recorded_by: string;
  recorded_at: string;
  voided_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  filename: string | null;
  /** A ten-minute link to the signed contract. */
  document_url: string | null;
}

/** One OEM product the customer chose, and the contract recorded for it. */
export interface OemContractSelection {
  selected_product_id: string;
  provider_name: string;
  product_name: string;
  term_months: number | null;
  customer_price: number | null;
  contract: OemRecordedContract | null;
  voided: OemRecordedContract[];
}

/** Verify's staff contracts panel: the customer's choices and their contracts. */
export interface ContractsPanel {
  provider_name: string;
  /** TEMPORARY: a test session on the QA server can run the co-buyer field test. */
  cobuyer_probe_available?: boolean;
  selections: {
    product_name: string;
    /** TecAssured's program name. Staff only. */
    program_name: string | null;
    provider_name: string;
    term_months: number | null;
    term_miles: number | null;
    customer_price: number | null;
  }[];
  contracts: {
    contract_number: string | null;
    product_name: string;
    /** TecAssured's program name. Staff only. */
    program_name: string | null;
    status: string;
    document_position: number | null;
    workdrive_file_id: string | null;
    workdrive_file_name: string | null;
    workdrive_saved_at: string | null;
    workdrive_url: string | null;
    voided_by: string | null;
    voided_at: string | null;
    void_reason: string | null;
    page_count: number | null;
    /** "Waiting for Deal Jacket", "Saved to Deal Jacket" or "Voided". Null before its document is fetched. */
    document_status: string | null;
    /** PS holds its PDF in the fni-contracts bucket. */
    held: boolean;
    /** A ten-minute link to the held PDF. */
    view_pdf_url: string | null;
  }[];
  /** Held documents not in the Deal Jacket yet, voided ones included. */
  waiting_count: number;
}
