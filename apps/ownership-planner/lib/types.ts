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
  tiers: OfferTier[];
}

export interface CatalogEntry {
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
