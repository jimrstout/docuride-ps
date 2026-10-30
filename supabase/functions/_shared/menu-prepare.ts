// _shared/menu-prepare.ts
//
// A deal's prepared menu (docs/multi-provider.md section 25, migration 0045):
// what Prepare menu shows and checks, and what Present menu offers.
//
// Columns across, categories down. Each cell is one product option: a plan
// and its term, mileage and deductible, from what rated on this deal. A cell
// starts from the preset (with its fallbacks, _shared/menu-presets.ts), or
// the column's coverage level when there is none, and staff can change it.
//
// ── Prices ────────────────────────────────────────────────────────────────
// A price belongs to the option, not the cell (optionKey): the same option in
// two columns has one price. It is the deal's price (fni.session_menu_prices)
// or the pricing rule's retail. The customer pays that price plus the
// vehicle's surcharges at their dealer cost: every mandatory option of the
// rate, and every surcharge chosen for the deal (sessions.menu_surcharges)
// that the rate offers. Surcharges are set once per deal and apply in every
// column. All money here is in cents.
//
// Pure, so a Node test can hold it.

import type { NormalizedFamily, RateVariant } from "./normalized-offer.ts";
import { resolveRule, type PricingRule } from "./planner-pricing.ts";
import type { MenuColumn } from "./menu-columns.ts";
import {
  CATEGORIES,
  checkPrice,
  optionKey,
  optionLabel,
  priceBand,
  resolvePreset,
  type Band,
  type Preset,
  type PresetPlan,
} from "./menu-presets.ts";

const cents = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(Number(n) * 100));

export interface CatalogPlan {
  provider_id: string;
  product_code: string;
  display_name: string;
  category: string;
  display_order: number | null;
}

export interface DealPrice {
  retail_price: number;
  above_band: boolean;
  approved_by: string | null;
  reason: string | null;
}

export interface SheetOption {
  key: string;
  label: string;
  rate_unique_id: string;
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  disappearing_deductible: boolean;
  /** Cents: the rate's own dealer cost, and the surcharges it carries on this deal. */
  dealer_cost: number;
  surcharge_cost: number;
  /** Cents: the pricing rule's retail, or null when the rule gives none. */
  rule_price: number | null;
  /** Cents: the option's price on this deal, before surcharges. Null: not priced. */
  price: number | null;
  band: Band;
  above_band: boolean;
  approved_by: string | null;
  reason: string | null;
  /** The codes of the surcharges that apply to it on this deal. */
  surcharge_codes: string[];
  /** Cents: what it always carries (mandatory options), and each surcharge it offers, by code. */
  mandatory_cost: number;
  option_costs: Record<string, number>;
}

export interface SheetPlan {
  provider_id: string;
  product_code: string;
  plan_name: string;
  display_order: number;
  purchased: boolean;
  options: SheetOption[];
}

export interface SheetCell {
  key: string | null;
  note: string | null;
}

export interface PrepareSheet {
  columns: { position: number; name: string }[];
  categories: string[];
  plans: Record<string, SheetPlan[]>;
  cells: Record<string, Record<string, SheetCell>>;
  surcharges: { available: { code: string; label: string }[]; chosen: string[] };
  prepared: boolean;
  /** Products already under a live contract: shown locked, in every column, at the price sold. */
  purchased: { category: string; plan_name: string; price: number }[];
  /**
   * Each column's extra payment terms, after the deal's own (_shared/menu-terms.ts):
   * as Prepare menu set them, else the presets'. Empty on a cash deal.
   */
  terms: Record<string, { months: number; rate: number }[]>;
  /** Products the customer removed from each column before choosing, by category. */
  removed: Record<string, string[]>;
}

export interface SheetInput {
  families: NormalizedFamily[];
  catalog: CatalogPlan[];
  rules: PricingRule[];
  columns: MenuColumn[];
  presets: Preset[];
  prepared: Record<string, Record<string, string | null>> | null;
  prices: Record<string, DealPrice>;
  surcharges: string[];
  /** "provider:product" for every product a live contract holds (_shared/purchased.ts). */
  purchased: Set<string>;
  /** Their saved selections' customer prices, in dollars, by "provider:product". */
  purchased_prices?: Record<string, number>;
  /** Extra terms per column, already resolved (deal's, else presets'); none on a cash deal. */
  terms?: Record<string, { months: number; rate: number }[]>;
  removed?: Record<string, string[]>;
}

function surchargesOf(rate: RateVariant, chosen: Set<string>): { cost: number; codes: string[] } {
  let cost = 0;
  const codes: string[] = [];
  for (const o of rate.options ?? []) {
    if (o.mandatory || chosen.has(o.code)) {
      cost += Math.round(Number(o.cost_delta ?? 0) * 100);
      codes.push(o.code);
    }
  }
  return { cost, codes };
}

/** Every surcharge a deal can choose: each non-mandatory option any rate offers, once. */
export function surchargeChoices(families: NormalizedFamily[]): { code: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const f of families) for (const t of f.tiers) for (const r of t.rates) {
    for (const o of r.options ?? []) if (!o.mandatory && !seen.has(o.code)) seen.set(o.code, o.label);
  }
  return [...seen.entries()].map(([code, label]) => ({ code, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/** The level index a column's starting level gives among n plans (as migration 0042). */
function levelIndex(level: string, n: number): number {
  if (n <= 1) return 0;
  if (level === "Highest") return n - 1;
  if (level === "Middle") return Math.floor((n - 1) / 2);
  return 0;
}

export function buildSheet(input: SheetInput): PrepareSheet {
  const chosen = new Set(input.surcharges);
  const catalogFor = (provider: string, code: string) =>
    input.catalog.find((c) => c.provider_id === provider && c.product_code === code) ?? null;

  const plans: Record<string, SheetPlan[]> = {};
  for (const f of input.families) {
    for (const t of f.tiers) {
      const provider = t.provider_id ?? f.provider_id ?? "";
      const cat = catalogFor(provider, t.product_code);
      const category = cat && (CATEGORIES as readonly string[]).includes(cat.category) ? cat.category : "Other";
      const options: SheetOption[] = t.rates
        .filter((r) => r.dealer_cost !== null && r.dealer_cost !== undefined)
        .map((r) => {
          const key = optionKey(provider, t.product_code, r);
          const dealerCost = cents(r.dealer_cost)!;
          const rulePrice = cents(r.retail_price ?? null);
          const rule = resolveRule(input.rules, t.product_code, Number(r.dealer_cost), provider);
          const band = priceBand(Number(r.dealer_cost), r.retail_price ?? null, rule as never);
          const deal = input.prices[key];
          const s = surchargesOf(r, chosen);
          const optionCosts: Record<string, number> = {};
          let mandatory = 0;
          for (const o of r.options ?? []) {
            const c = Math.round(Number(o.cost_delta ?? 0) * 100);
            if (o.mandatory) mandatory += c;
            else optionCosts[o.code] = c;
          }
          return {
            key,
            label: optionLabel(r),
            rate_unique_id: r.rate_unique_id,
            term_months: r.term_months,
            term_miles: r.term_miles,
            deductible: r.deductible,
            disappearing_deductible: !!r.disappearing_deductible,
            dealer_cost: dealerCost,
            surcharge_cost: s.cost,
            rule_price: rulePrice,
            price: deal ? cents(deal.retail_price) : rulePrice,
            band,
            above_band: deal?.above_band ?? false,
            approved_by: deal?.approved_by ?? null,
            reason: deal?.reason ?? null,
            surcharge_codes: s.codes,
            mandatory_cost: mandatory,
            option_costs: optionCosts,
          };
        });
      if (options.length === 0) continue;
      (plans[category] ??= []).push({
        provider_id: provider,
        product_code: t.product_code,
        plan_name: cat?.display_name ?? t.product_name,
        display_order: cat?.display_order ?? 999,
        purchased: input.purchased.has(`${provider}:${t.product_code}`),
        options,
      });
    }
  }
  for (const list of Object.values(plans)) list.sort((a, b) => a.display_order - b.display_order || a.plan_name.localeCompare(b.plan_name));
  const categories = (CATEGORIES as readonly string[]).filter((c) => (plans[c]?.length ?? 0) > 0);

  // Every catalog plan in a category, rated or not, so a preset naming one that
  // did not rate can fall back to the plan below it.
  const presetPlans = (category: string): PresetPlan<SheetOption & { rate_unique_id: string }>[] => {
    const rated = (plans[category] ?? []).filter((p) => !p.purchased).map((p) => ({
      provider_id: p.provider_id, product_code: p.product_code, plan_name: p.plan_name, display_order: p.display_order, rates: p.options,
    }));
    const unrated = input.catalog
      .filter((c) => c.category === category && !rated.some((r) => r.plan_name === c.display_name))
      .map((c) => ({ provider_id: c.provider_id, product_code: c.product_code, plan_name: c.display_name, display_order: c.display_order ?? 999, rates: [] }));
    return [...rated, ...unrated];
  };

  const columns = input.columns.map((c, i) => ({ position: i + 1, name: c.name }));
  const cells: Record<string, Record<string, SheetCell>> = {};
  for (const [i, col] of input.columns.entries()) {
    const pos = String(i + 1);
    cells[pos] = {};
    for (const category of categories) {
      const saved = input.prepared?.[pos];
      if (saved && category in saved) {
        const key = saved[category];
        const known = key === null || (plans[category] ?? []).some((p) => p.options.some((o) => o.key === key));
        cells[pos][category] = known
          ? { key, note: null }
          : { key: null, note: "The option prepared here is no longer offered. Choose another." };
        continue;
      }
      const preset = input.presets.find((p) => p.column_position === i + 1 && p.category === category) ?? null;
      const usable = presetPlans(category);
      const ratedByPrice = usable.filter((p) => p.rates.length > 0)
        .sort((a, b) => Math.min(...a.rates.map((r) => r.price ?? Infinity)) - Math.min(...b.rates.map((r) => r.price ?? Infinity)));
      const level = ratedByPrice[levelIndex(col.starting_level, ratedByPrice.length)] ?? null;
      if (!preset) {
        // No preset: the column's own rule, as before (migration 0042).
        if (!(col.preset_categories as string[]).includes(category) || !level) {
          cells[pos][category] = { key: null, note: null };
        } else {
          const r = resolvePreset({ column_position: i + 1, category, provider_id: null, plan_name: null, term_months: null, term_miles: null, deductible: null, disappearing_deductible: null }, usable, level);
          cells[pos][category] = { key: r.rate?.key ?? null, note: r.note };
        }
        continue;
      }
      const r = resolvePreset(preset, usable, level);
      cells[pos][category] = { key: r.rate?.key ?? null, note: r.note };
    }
  }

  const purchasedRows: PrepareSheet["purchased"] = [];
  for (const [category, list] of Object.entries(plans)) {
    for (const p of list.filter((x) => x.purchased)) {
      const price = input.purchased_prices?.[`${p.provider_id}:${p.product_code}`];
      purchasedRows.push({ category, plan_name: p.plan_name, price: price === undefined ? 0 : Math.round(price * 100) });
    }
  }

  return {
    columns,
    categories,
    plans,
    cells,
    purchased: purchasedRows,
    terms: Object.fromEntries(columns.map((c) => [String(c.position), (input.terms?.[String(c.position)] ?? []).slice(0, 2)])),
    removed: Object.fromEntries(columns.map((c) => [String(c.position), input.removed?.[String(c.position)] ?? []])),
    surcharges: { available: surchargeChoices(input.families), chosen: input.surcharges.filter((c) => surchargeChoices(input.families).some((s) => s.code === c)) },
    prepared: input.prepared !== null,
  };
}

/** Find an option on the sheet. */
export function optionFor(sheet: PrepareSheet, key: string): { category: string; plan: SheetPlan; option: SheetOption } | null {
  for (const [category, list] of Object.entries(sheet.plans)) {
    for (const plan of list) {
      const option = plan.options.find((o) => o.key === key);
      if (option) return { category, plan, option };
    }
  }
  return null;
}

/** What the customer pays for an option on this deal, in cents: its price and its surcharges. */
export function customerCents(o: SheetOption): number | null {
  return o.price === null ? null : o.price + o.surcharge_cost;
}

export interface Preparation {
  cells: Record<string, Record<string, string | null>>;
  /** Cents per option key, before surcharges. Only the options staff set. */
  prices: Record<string, number>;
  surcharges: string[];
}

export interface PreparationCheck {
  errors: string[];
  /** Options priced above the band: a manager and a reason are needed. */
  above_band: string[];
  writes: { key: string; retail_cents: number; above_band: boolean }[];
}

/**
 * Check what Prepare menu sends against the sheet. Plain English, one sentence
 * per problem. A price is never below dealer cost; above the band is allowed
 * only with a manager, which the caller checks.
 */
export function checkPreparation(sheet: PrepareSheet, p: Preparation): PreparationCheck {
  const errors: string[] = [];
  const above: string[] = [];
  const writes: PreparationCheck["writes"] = [];
  const known = new Set(sheet.surcharges.available.map((s) => s.code));
  for (const code of p.surcharges) if (!known.has(code)) errors.push("A surcharge chosen is not offered on this vehicle.");
  for (const [pos, row] of Object.entries(p.cells ?? {})) {
    const col = sheet.columns.find((c) => String(c.position) === pos);
    if (!col) { errors.push("A column chosen is not on this menu."); continue; }
    for (const [category, key] of Object.entries(row ?? {})) {
      if (key === null) continue;
      const found = optionFor(sheet, key);
      if (!found || found.category !== category) errors.push(`${col.name}, ${category}: that option is not offered on this vehicle.`);
      else if (found.plan.purchased) errors.push(`${col.name}, ${category}: ${found.plan.plan_name} is already purchased, so it cannot be changed.`);
    }
  }
  for (const [key, priceCents] of Object.entries(p.prices ?? {})) {
    const found = optionFor(sheet, key);
    if (!found) { errors.push("A price was set for an option not offered on this vehicle."); continue; }
    const { plan, option } = found;
    const name = `${plan.plan_name}, ${option.label}`;
    if (plan.purchased) { errors.push(`${name} is already purchased, so its price cannot be changed.`); continue; }
    const check = checkPrice(priceCents, option.dealer_cost / 100, option.band);
    if (!check.ok) { errors.push(`${name}: ${check.reason}`); continue; }
    if (check.above_band) above.push(key);
    writes.push({ key, retail_cents: priceCents, above_band: check.above_band });
  }
  return { errors: [...new Set(errors)], above_band: above, writes };
}

// ── What Present menu takes from it ───────────────────────────────────────

/**
 * The deal's prices onto the priced families, in place: each rate's retail
 * price becomes the deal's price for its option where one was set. The
 * planner, the menu and the save all price from these, so the price on the
 * chosen option is the one the customer pays (fni-session-get,
 * fni-session-save). Prices in dollars, as the families hold them.
 */
export function applyDealPrices(families: NormalizedFamily[], prices: Record<string, DealPrice>): NormalizedFamily[] {
  for (const f of families) for (const t of f.tiers) {
    const provider = t.provider_id ?? f.provider_id ?? "";
    for (const r of t.rates) {
      const deal = prices[optionKey(provider, t.product_code, r)];
      if (deal) r.retail_price = deal.retail_price;
    }
  }
  return families;
}

export interface PreparedChoice {
  provider_id: string;
  product_code: string;
  rate_unique_id: string;
}

/** Each column's choice per category, and the deal's surcharges, for the menu's cells. */
export function preparedForMenu(sheet: PrepareSheet): {
  cells: Record<string, Record<string, PreparedChoice | null>>;
  surcharges: string[];
} {
  const cells: Record<string, Record<string, PreparedChoice | null>> = {};
  for (const [pos, row] of Object.entries(sheet.cells)) {
    cells[pos] = {};
    for (const [category, cell] of Object.entries(row)) {
      const found = cell.key ? optionFor(sheet, cell.key) : null;
      cells[pos][category] = found
        ? { provider_id: found.plan.provider_id, product_code: found.plan.product_code, rate_unique_id: found.option.rate_unique_id }
        : null;
    }
  }
  return { cells, surcharges: sheet.surcharges.chosen };
}
