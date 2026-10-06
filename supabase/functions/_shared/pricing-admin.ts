// _shared/pricing-admin.ts
//
// What the admin area's Pricing page needs, worked out on the server.
//
// ── Why here, and not in the planner app ────────────────────────────────
// The page previews prices. A preview that used its own copy of the formula
// would be a second formula, and the day the two disagree staff would be
// looking at a number no customer is shown. So the preview calls the same
// priceProduct and resolveRule the planner prices with, from the same file, and
// the page only renders what comes back.
//
// Nothing here changes how a price is worked out. This module reads rules,
// checks a proposed rule before it is saved, and describes rules in words.
//
// Its own file, with no remote imports, so all of it can be tested from Node.

import { priceProduct, resolveRule, type PricingRule } from "./planner-pricing.ts";

/** A rule as stored, with who last changed it. */
export interface StoredRule extends PricingRule {
  updated_at?: string | null;
  updated_by?: string | null;
}

/** The fields a person edits. Store and tenant come from the scope, not the form. */
export interface RuleFields {
  product_code: string | null;
  cost_floor: number;
  cost_ceiling: number;
  markup_percent: number;
  markup_min_dollars: number;
  markup_max_dollars: number | null;
  round_to: number;
  active: boolean;
}

/** The costs the preview always shows. */
export const SAMPLE_COSTS: readonly number[] = [100, 300, 600, 1200, 2500];

/** The range the gap check covers. */
export const GAP_RANGE = { from: 0, to: 10000 } as const;

/**
 * The code the preview prices "All products" as.
 *
 * No product is catalogued under it, so no product-specific rule can match and
 * the preview shows exactly what the catch-all rules give.
 */
export const ANY_PRODUCT = "\u0000any-product";

// ── Reading what was typed ──────────────────────────────────────────────

/** A typed amount, or null for a blank box, or NaN for something unreadable. */
function amount(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[$,%\s]/g, "");
  if (s === "") return null;
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

/** At most `places` decimals, matching the column, or it is refused. */
function fits(n: number, places: number): boolean {
  const scaled = n * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/**
 * The fields of a rule, from a form, or the reasons it cannot be read.
 *
 * Plain English, one sentence per problem, so the page can show them as they
 * are. Every rule about one field is checked here; rules that need the other
 * saved rules are in validateRule.
 */
export function parseRuleFields(raw: Record<string, unknown>): { fields: RuleFields } | { errors: string[] } {
  const errors: string[] = [];

  const read = (key: string, label: string, opts: { required: boolean; places: number }) => {
    const n = amount(raw[key]);
    if (n === null) {
      if (opts.required) errors.push(`${label} is required.`);
      return null;
    }
    if (Number.isNaN(n)) {
      errors.push(`${label} must be a number.`);
      return null;
    }
    if (n < 0) {
      errors.push(`${label} cannot be negative.`);
      return null;
    }
    if (!fits(n, opts.places)) {
      errors.push(
        opts.places === 2
          ? `${label} can have at most two decimal places.`
          : `${label} can have at most ${opts.places} decimal places.`
      );
      return null;
    }
    return n;
  };

  const floor = read("cost_floor", "Dealer cost from", { required: true, places: 2 });
  const ceiling = read("cost_ceiling", "Dealer cost to", { required: true, places: 2 });
  const pct = read("markup_percent", "Markup percent", { required: true, places: 3 });
  const min = read("markup_min_dollars", "Minimum markup", { required: false, places: 2 });
  const max = read("markup_max_dollars", "Maximum markup", { required: false, places: 2 });
  const round = read("round_to", "Round to", { required: false, places: 2 });

  if (floor !== null && ceiling !== null && !(floor < ceiling)) {
    errors.push("Dealer cost from must be less than Dealer cost to.");
  }
  if (min !== null && max !== null && min > max) {
    errors.push("Minimum markup cannot be more than the maximum markup.");
  }

  if (errors.length > 0) return { errors };

  const code = typeof raw.product_code === "string" ? raw.product_code.trim() : "";
  const active = raw.active === true || raw.active === "on" || raw.active === "true";

  return {
    fields: {
      product_code: code === "" ? null : code,
      cost_floor: floor!,
      cost_ceiling: ceiling!,
      markup_percent: pct!,
      // A blank minimum is no minimum, which the column stores as 0.
      markup_min_dollars: min ?? 0,
      // A blank maximum is no maximum.
      markup_max_dollars: max,
      // A blank round-to is the column's default.
      round_to: round ?? 5,
      active,
    },
  };
}

// ── Checks against the other rules ─────────────────────────────────────

/** Bands are [from, to), so one that ends where another starts does not overlap it. */
export function bandsOverlap(
  a: { cost_floor: number; cost_ceiling: number },
  b: { cost_floor: number; cost_ceiling: number }
): boolean {
  return a.cost_floor < b.cost_ceiling && b.cost_floor < a.cost_ceiling;
}

/**
 * Why a rule cannot be saved into a scope, or an empty list if it can.
 *
 * `storeId` is null for All stores. `others` is every saved rule for the tenant;
 * the rule being edited, if any, is left out by `editingId`.
 */
export function validateRule(
  fields: RuleFields,
  storeId: string | null,
  others: StoredRule[],
  editingId: string | null,
  activeStoreIds: ReadonlySet<string>,
  names: { store?: (id: string) => string; product?: (code: string | null) => string } = {}
): string[] {
  const errors: string[] = [];

  if (storeId !== null && !activeStoreIds.has(storeId)) {
    errors.push(
      "That store does not have an active TecAssured account, so it cannot have its own pricing."
    );
  }

  if (fields.active) {
    const clash = others.find(
      (r) =>
        r.id !== editingId &&
        r.active &&
        r.store_id === storeId &&
        r.product_code === fields.product_code &&
        bandsOverlap(r, fields)
    );
    if (clash) {
      const what = (names.product ?? defaultProductName)(fields.product_code);
      errors.push(
        `This overlaps the active rule for ${what} from ${money(clash.cost_floor)} to ` +
          `${money(clash.cost_ceiling)}. Change the costs so they do not overlap, or turn one of them off. ` +
          `One rule may end where the next begins.`
      );
    }
  }

  return errors;
}

/** Why a copy cannot go ahead, or null if it can. */
export function copyRefusal(
  fromStoreId: string | null,
  toStoreId: string | null,
  rules: StoredRule[],
  activeStoreIds: ReadonlySet<string>
): string | null {
  if (fromStoreId === toStoreId) return "Choose a different place to copy these rules to.";
  if (toStoreId !== null && !activeStoreIds.has(toStoreId)) {
    return "That store does not have an active TecAssured account, so it cannot have its own pricing.";
  }
  if (!rules.some((r) => r.store_id === fromStoreId)) return "There are no rules here to copy.";
  if (rules.some((r) => r.store_id === toStoreId)) {
    return "That already has rules. Copying only goes to a place with none, so nothing is overwritten. Delete its rules first if you mean to replace them.";
  }
  return null;
}

// ── Words ──────────────────────────────────────────────────────────────

/** $400, $5,000, $12.50. Cents only when there are cents. */
export function money(n: number): string {
  const whole = Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** 250%, 12.5%. */
export function percent(n: number): string {
  return `${Number(n.toFixed(3))}%`;
}

function defaultProductName(code: string | null): string {
  return code === null ? "all products" : code;
}

/**
 * One rule in a sentence.
 *
 * "Products costing $0 to $400: 250% markup, at least $75, no more than $600,
 * rounded to $5."
 */
export function ruleSummary(
  rule: Pick<RuleFields, "product_code" | "cost_floor" | "cost_ceiling" | "markup_percent" | "markup_min_dollars" | "markup_max_dollars" | "round_to" | "active">,
  productName: string | null = null
): string {
  const who = rule.product_code === null ? "Products" : (productName ?? rule.product_code);
  const parts = [`${percent(rule.markup_percent)} markup`];
  if (rule.markup_min_dollars > 0) parts.push(`at least ${money(rule.markup_min_dollars)}`);
  parts.push(
    rule.markup_max_dollars === null || rule.markup_max_dollars === undefined
      ? "no maximum"
      : `no more than ${money(rule.markup_max_dollars)}`
  );
  parts.push(rule.round_to > 0 ? `rounded to ${money(rule.round_to)}` : "not rounded");
  const sentence =
    `${who} costing ${money(rule.cost_floor)} to ${money(rule.cost_ceiling)}: ${parts.join(", ")}.`;
  return rule.active ? sentence : `Turned off. ${sentence}`;
}

// ── Stores ─────────────────────────────────────────────────────────────

export type StoreStatus = "Own rules" | "Uses All stores" | "No pricing: products will not be shown";

/**
 * Where a store's prices come from, as the planner would find them.
 *
 * Own rules: it has at least one active rule of its own. Uses All stores: it has
 * none, and All stores has at least one active rule. Otherwise nothing prices
 * its products, and the planner leaves them out.
 */
export function storeStatus(rules: StoredRule[], storeId: string): StoreStatus {
  if (rules.some((r) => r.active && r.store_id === storeId)) return "Own rules";
  if (rules.some((r) => r.active && r.store_id === null)) return "Uses All stores";
  return "No pricing: products will not be shown";
}

/**
 * The rules the planner would load for a scope: the store's own and All
 * stores, exactly as fni-session-get selects them. For All stores, only its own.
 */
export function rulesInForce(rules: StoredRule[], storeId: string | null): StoredRule[] {
  return rules.filter((r) => r.active && (r.store_id === null || (storeId !== null && r.store_id === storeId)));
}

// ── Preview ────────────────────────────────────────────────────────────

export interface PreviewRow {
  cost: number;
  price: number | null;
  rule_id: string | null;
  /** Where the rule came from: this scope, or All stores. */
  rule_from: "This store" | "All stores" | null;
  rule_summary: string | null;
  reason: string | null;
}

/**
 * What a product would sell for at each cost, through the planner's own
 * priceProduct and resolveRule, with the fallback to All stores.
 */
export function previewPrices(
  rules: StoredRule[],
  storeId: string | null,
  costs: readonly number[],
  productCode: string | null,
  productName: (code: string | null) => string | null = () => null
): PreviewRow[] {
  const inForce = rulesInForce(rules, storeId);
  const code = productCode ?? ANY_PRODUCT;

  return costs.map((cost) => {
    const priced = priceProduct(inForce, code, cost);
    const rule = priced.rule_id ? resolveRule(inForce, code, cost) : null;
    if (!rule || priced.unpriced_reason) {
      return {
        cost,
        price: null,
        rule_id: null,
        rule_from: null,
        rule_summary: null,
        reason: "No rule covers this cost, so the product would not be shown.",
      };
    }
    return {
      cost,
      price: priced.retail_price,
      rule_id: rule.id,
      rule_from: rule.store_id === null ? "All stores" : "This store",
      rule_summary: ruleSummary(rule, productName(rule.product_code)),
      reason: null,
    };
  });
}

// ── Gaps ───────────────────────────────────────────────────────────────

export interface Gap {
  from: number;
  to: number;
}

/**
 * Costs from $0 to $10,000 that no rule prices, for a product with no rule of
 * its own, once All stores has been fallen back to.
 *
 * Built from where the bands start and end, not by sampling, so a gap of a cent
 * is still found. Every point between two consecutive edges is either covered
 * by some active rule the planner would consult or by none, so testing each
 * span's start is exact.
 */
export function pricingGaps(rules: StoredRule[], storeId: string | null, productCode: string | null = null): Gap[] {
  const inForce = rulesInForce(rules, storeId);
  const code = productCode ?? ANY_PRODUCT;

  const edges = new Set<number>([GAP_RANGE.from, GAP_RANGE.to]);
  for (const r of inForce) {
    for (const e of [r.cost_floor, r.cost_ceiling]) {
      if (e > GAP_RANGE.from && e < GAP_RANGE.to) edges.add(e);
    }
  }
  const points = [...edges].sort((a, b) => a - b);

  const gaps: Gap[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (resolveRule(inForce, code, from) !== null) continue;
    const last = gaps[gaps.length - 1];
    if (last && last.to === from) last.to = to;
    else gaps.push({ from, to });
  }
  return gaps;
}

/** "Costs from $X to $Y have no rule. Those products will not be shown." */
export function gapSentence(gap: Gap): string {
  return `Costs from ${money(gap.from)} to ${money(gap.to)} have no rule. Those products will not be shown.`;
}
