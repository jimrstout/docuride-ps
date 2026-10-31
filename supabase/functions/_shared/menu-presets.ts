// _shared/menu-presets.ts
//
// Menu presets and the prices staff may set on a deal (docs/multi-provider.md
// section 25, migration 0045).
//
// ── Presets ───────────────────────────────────────────────────────────────
// Per menu template, Financed or Cash, column and category, a manager picks a
// preferred plan ("Priority Maintenance, Gold"), term, mileage and deductible.
// A deal's cell starts from it. When the vehicle does not rate for it:
//
//   1. the same plan, at the closest term (a tie goes to the shorter), then the
//      closest mileage, then the closest deductible, a disappearing deductible
//      preferred only when asked for
//   2. the plan did not rate at all: the next lower plan in the category, by
//      catalog display order, the same way; then the next lower again
//   3. nothing at or below it rated: no cell, with a plain note. A higher plan
//      is never put in its place, since that would raise the price.
//
// With no preferred plan the column's starting level decides (migration 0042),
// and the term, mileage and deductible preferences still pick its rate.
//
// ── Prices ────────────────────────────────────────────────────────────────
// A deal's price belongs to the product option, not the cell: the product,
// term, miles, deductible and whether it disappears (optionKey). The same
// option in two columns has one price. Its default is the pricing rule's
// retail (_shared/planner-pricing.ts). Staff may set it within the band:
//
//   floor   dealer cost plus the rule's minimum markup, never below dealer cost
//   top     dealer cost plus the rule's maximum markup (max_markup_percent and
//           max_markup_dollars, the lower when both are set), or the rule's
//           own retail when neither is set. Never below the rule's own retail:
//           the default price never needs a manager.
//
// Above the top needs a manager and a reason. Below dealer cost never.
//
// Pure, so a Node test can hold it. Words are for staff: plain English.

import { isServiceDriveName } from "./service-drive.ts";

export const CATEGORIES = [
  "Mechanical Protection", "Maintenance", "Tire and Wheel", "Theft", "Battery", "Appearance", "Other",
] as const;

export const DEAL_TYPES = ["Financed", "Cash"] as const;
export type PresetDealType = (typeof DEAL_TYPES)[number];

/** A session's finance type as the presets name it. Lease is financed. */
export function presetDealType(financeType: unknown): PresetDealType {
  return String(financeType ?? "").trim().toLowerCase() === "cash" ? "Cash" : "Financed";
}

export const NOT_OFFERED = "Not offered on this vehicle";

export interface Preset {
  column_position: number;
  category: string;
  provider_id: string | null;
  plan_name: string | null;
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  disappearing_deductible: boolean | null;
}

/** One rated option of a plan. */
export interface PresetRate {
  rate_unique_id: string;
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  disappearing_deductible?: boolean | null;
}

/** A plan that rated in the category, with its catalog name and order. */
export interface PresetPlan<R extends PresetRate = PresetRate> {
  provider_id: string;
  product_code: string;
  plan_name: string;
  display_order: number;
  rates: R[];
}

export interface Resolved<R extends PresetRate = PresetRate> {
  plan: PresetPlan<R> | null;
  rate: R | null;
  /** Why the cell is not exactly the preset, in plain English, or null. */
  note: string | null;
}

// ── Labels ────────────────────────────────────────────────────────────────

/** "4 years", "18 months", "1 year". */
export function termLabel(months: number | null | undefined): string {
  if (!months || months <= 0) return "No set term";
  if (months % 12 === 0) return months === 12 ? "1 year" : `${months / 12} years`;
  return months === 1 ? "1 month" : `${months} months`;
}

/** "Unlimited miles", "36,000 miles". */
export function milesLabel(miles: number | null | undefined): string {
  if (!miles) return "Unlimited miles";
  return `${miles.toLocaleString("en-US")} miles`;
}

/** "$100 Disappearing Deductible", "$50 Deductible", "No deductible". */
export function deductibleLabel(amount: number | null | undefined, disappearing?: boolean | null): string {
  if (!amount) return "No deductible";
  const dollars = Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
  return `${dollars} ${disappearing ? "Disappearing Deductible" : "Deductible"}`;
}

/** "4 years / Unlimited miles, $100 Disappearing Deductible". */
export function optionLabel(r: PresetRate): string {
  return `${termLabel(r.term_months)} / ${milesLabel(r.term_miles)}, ${deductibleLabel(r.deductible, r.disappearing_deductible)}`;
}

/** The option's identity on a deal: one price for it in every column. */
export function optionKey(providerId: string, productCode: string, r: PresetRate): string {
  return [
    providerId, productCode, r.term_months ?? 0, r.term_miles ?? 0, Number(r.deductible ?? 0).toFixed(2),
    r.disappearing_deductible ? "D" : "S",
  ].join("|");
}

// ── Fallbacks ─────────────────────────────────────────────────────────────

function closestRate<R extends PresetRate>(rates: R[], p: Preset): R | null {
  if (rates.length === 0) return null;
  const dist = (a: number | null | undefined, b: number | null) => (b === null ? 0 : Math.abs((a ?? 0) - b));
  const scored = rates.map((r, i) => ({
    r, i,
    term: dist(r.term_months, p.term_months),
    shorter: r.term_months ?? 0,
    miles: dist(r.term_miles, p.term_miles),
    deduct: dist(r.deductible, p.deductible),
    kind: p.disappearing_deductible === null ? 0 : (!!r.disappearing_deductible === p.disappearing_deductible ? 0 : 1),
  }));
  scored.sort((a, b) =>
    a.term - b.term || a.shorter - b.shorter || a.miles - b.miles || a.deduct - b.deduct || a.kind - b.kind || a.i - b.i
  );
  return scored[0].r;
}

function exactly(r: PresetRate, p: Preset): boolean {
  return (p.term_months === null || r.term_months === p.term_months) &&
    (p.term_miles === null || (r.term_miles ?? 0) === p.term_miles) &&
    (p.deductible === null || Number(r.deductible ?? 0) === Number(p.deductible)) &&
    (p.disappearing_deductible === null || !!r.disappearing_deductible === p.disappearing_deductible);
}

/**
 * The cell a preset gives on this deal. `plans` are the category's plans that
 * rated; `levelPlan` is the column's starting-level choice, used when the
 * preset names no plan.
 */
export function resolvePreset<R extends PresetRate>(
  preset: Preset,
  plans: PresetPlan<R>[],
  levelPlan: PresetPlan<R> | null = null
): Resolved<R> {
  const rated = plans.filter((p) => p.rates.length > 0).sort((a, b) => a.display_order - b.display_order);
  if (rated.length === 0) return { plan: null, rate: null, note: NOT_OFFERED };

  let plan: PresetPlan<R> | null = null;
  let planNote: string | null = null;
  if (preset.plan_name === null) {
    plan = levelPlan && rated.includes(levelPlan) ? levelPlan : rated[0];
  } else {
    plan = rated.find((p) => p.plan_name === preset.plan_name && (preset.provider_id === null || p.provider_id === preset.provider_id)) ?? null;
    if (!plan) {
      // The order the preferred plan holds, from any plan of that name, rated or not.
      const wanted = plans.find((p) => p.plan_name === preset.plan_name)?.display_order;
      const lower = wanted === undefined ? [] : rated.filter((p) => p.display_order < wanted);
      if (lower.length === 0) {
        return { plan: null, rate: null, note: `${preset.plan_name} and the plans below it are not offered on this vehicle.` };
      }
      plan = lower[lower.length - 1];
      planNote = `${preset.plan_name} did not rate on this vehicle, so ${plan.plan_name} is offered.`;
    }
  }

  const rate = closestRate(plan.rates, preset);
  if (!rate) return { plan: null, rate: null, note: NOT_OFFERED };
  const rateNote = exactly(rate, preset) ? null : `The preset is not offered on this vehicle, so the closest is used: ${optionLabel(rate)}.`;
  return { plan, rate, note: planNote ?? rateNote };
}

// ── The price band ────────────────────────────────────────────────────────

export interface BandRule {
  markup_min_dollars?: number | null;
  max_markup_percent?: number | null;
  max_markup_dollars?: number | null;
}

export interface Band {
  /** In cents. Never below dealer cost. */
  floor: number;
  /** In cents: the most without a manager. */
  top: number;
}

const cents = (n: number) => Math.round(n * 100);

/** The band for an option, from its dealer cost, its rule and the rule's own retail. */
export function priceBand(dealerCost: number, ruleRetail: number | null, rule: BandRule | null): Band {
  const cost = cents(dealerCost);
  const floor = cost + Math.max(0, cents(Number(rule?.markup_min_dollars ?? 0)));
  const pct = rule?.max_markup_percent ?? null;
  const dol = rule?.max_markup_dollars ?? null;
  let top: number;
  if (pct === null && dol === null) {
    top = ruleRetail === null ? cost : cents(ruleRetail);
  } else {
    const byPct = pct === null ? Infinity : Math.round(cost * Number(pct) / 100);
    const byDol = dol === null ? Infinity : cents(Number(dol));
    top = cost + Math.min(byPct, byDol);
  }
  if (ruleRetail !== null) top = Math.max(top, cents(ruleRetail));
  return { floor: Math.min(floor, Math.max(top, cost)), top: Math.max(top, cost) };
}

export type PriceCheck =
  | { ok: true; above_band: boolean }
  | { ok: false; reason: string };

/** Whether staff may set this price, and whether it needs a manager. */
export function checkPrice(priceCents: number, dealerCost: number, band: Band): PriceCheck {
  if (!Number.isInteger(priceCents) || priceCents < 0) return { ok: false, reason: "The price is not a dollar amount." };
  if (priceCents < cents(dealerCost)) return { ok: false, reason: "A price cannot be below dealer cost." };
  if (priceCents < band.floor) return { ok: false, reason: "The price is below the lowest this product may be sold for." };
  return { ok: true, above_band: priceCents > band.top };
}

// ── Saving presets ────────────────────────────────────────────────────────

const intOrNull = (v: unknown): number | null => {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isInteger(n) && n >= 0 ? n : NaN;
};

/**
 * The presets a form sends, checked. Keys are `p_<position>_<category index>_<field>`
 * with fields plan, term, miles, deductible, kind ("Disappearing" | "Standard" | "").
 */
export function parsePresets(
  form: Record<string, unknown>,
  columns: number,
  planNames: Set<string>
): { presets: Preset[] } | { errors: string[] } {
  const errors: string[] = [];
  const presets: Preset[] = [];
  for (let pos = 1; pos <= columns; pos++) {
    CATEGORIES.forEach((category, ci) => {
      const f = (name: string) => form[`p_${pos}_${ci}_${name}`];
      const plan = String(f("plan") ?? "").trim();
      const term = intOrNull(f("term"));
      const miles = intOrNull(f("miles"));
      const deductible = intOrNull(f("deductible"));
      const kind = String(f("kind") ?? "").trim();
      if (plan === "" && term === null && miles === null && deductible === null && kind === "") return;
      if (plan !== "" && isServiceDriveName(plan)) errors.push(`Column ${pos}, ${category}: ${plan} is for service drive sales only. Choose another plan.`);
      else if (plan !== "" && !planNames.has(plan)) errors.push(`Column ${pos}, ${category}: "${plan}" is not a plan in the catalog.`);
      if (Number.isNaN(term) || term === 0) errors.push(`Column ${pos}, ${category}: the term is not a number of months.`);
      if (Number.isNaN(miles)) errors.push(`Column ${pos}, ${category}: the mileage is not a number.`);
      if (Number.isNaN(deductible)) errors.push(`Column ${pos}, ${category}: the deductible is not a dollar amount.`);
      if (kind !== "" && kind !== "Disappearing" && kind !== "Standard") errors.push(`Column ${pos}, ${category}: the deductible type is not one offered.`);
      presets.push({
        column_position: pos,
        category,
        provider_id: null,
        plan_name: plan === "" ? null : plan,
        term_months: Number.isNaN(term) ? null : term,
        term_miles: Number.isNaN(miles) ? null : miles,
        deductible: Number.isNaN(deductible) ? null : deductible,
        disappearing_deductible: kind === "" ? null : kind === "Disappearing",
      });
    });
  }
  return errors.length > 0 ? { errors } : { presets };
}

/** "Column 2, Maintenance: Priority Maintenance, Gold, 4 years". For the change log and the page. */
export function presetLine(p: Preset, columnName?: string): string {
  const parts = [
    p.plan_name ?? "the column's level",
    p.term_months ? termLabel(p.term_months) : null,
    p.term_miles !== null ? milesLabel(p.term_miles) : null,
    p.deductible !== null ? deductibleLabel(p.deductible, p.disappearing_deductible) : null,
  ].filter(Boolean);
  return `${columnName ?? `Column ${p.column_position}`}, ${p.category}: ${parts.join(", ")}`;
}
