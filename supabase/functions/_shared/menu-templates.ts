// _shared/menu-templates.ts
//
// Which template a deal gets, and what its slots show. See
// docs/multi-provider.md, section 4.
//
// Pure, so a Node test can hold the matching rules and the slot rules to
// account. The rows are read by _shared/menu-template-rows.ts.

import { categoryOf, unplacedNote } from "./product-category.ts";
import { isServiceDrivePlan } from "./service-drive.ts";
import { makeMatches } from "./providers.ts";
import type { NormalizedFamily, NormalizedTier } from "./normalized-offer.ts";

export const SLOT_MODES = ["Best Match", "Side by Side"] as const;
export type SlotMode = (typeof SLOT_MODES)[number];

export interface MenuTemplate {
  id: string;
  name: string;
  store_ids: string[];
  /** "Loan", "Cash". */
  deal_types: string[];
  /** Verify's vehicle type choices: "UTV", "On-Road Motorcycle". */
  vehicle_types: string[];
  /** "New", "Used". */
  conditions: string[];
  makes: string[];
  priority: number;
  active: boolean;
  updated_at: string;
}

export interface TemplateSlot {
  id: string;
  template_id: string;
  position: number;
  title: string;
  category: string | null;
  mode: SlotMode;
  /** fni.product_catalog ids, in order of preference. */
  product_ids: string[];
}

/** The deal, as template matching sees it. */
export interface TemplateDeal {
  store_id: string;
  /** sessions.finance_type: "Loan" or "Cash". */
  deal_type: string | null;
  /** The vehicle type as staff see it on Verify ("On-Road Motorcycle"). */
  vehicle_type: string | null;
  condition: string | null;
  make: string | null;
}

/** A catalog row, as much as a slot needs to find its offers. */
export interface SlotProduct {
  provider_id: string;
  product_code: string;
}

const same = (a: string | null | undefined, b: string) =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/** How many conditions a template specifies. More is more specific. */
export function specificity(t: MenuTemplate): number {
  return [t.store_ids, t.deal_types, t.vehicle_types, t.conditions, t.makes].filter(
    (list) => list.length > 0
  ).length;
}

/** Every condition the template specifies matches the deal. */
export function templateMatches(t: MenuTemplate, deal: TemplateDeal): boolean {
  if (t.store_ids.length > 0 && !t.store_ids.includes(deal.store_id)) return false;
  if (t.deal_types.length > 0 && !t.deal_types.some((d) => same(deal.deal_type, d))) return false;
  if (t.vehicle_types.length > 0 && !t.vehicle_types.some((v) => same(deal.vehicle_type, v))) {
    return false;
  }
  if (t.conditions.length > 0 && !t.conditions.some((c) => same(deal.condition, c))) return false;
  if (t.makes.length > 0 && !makeMatches(t.makes, deal.make)) return false;
  return true;
}

/**
 * The template for a deal: among active templates that match, the most
 * specific; then the higher priority; then the most recently updated.
 */
export function chooseTemplate(templates: MenuTemplate[], deal: TemplateDeal): MenuTemplate | null {
  const matching = templates.filter((t) => t.active && templateMatches(t, deal));
  matching.sort(
    (a, b) =>
      specificity(b) - specificity(a) ||
      b.priority - a.priority ||
      Date.parse(b.updated_at) - Date.parse(a.updated_at)
  );
  return matching[0] ?? null;
}

/** One slot as the menu will show it. */
export interface ResolvedSlot {
  slot_id: string;
  position: number;
  title: string;
  category: string | null;
  mode: SlotMode;
  /** The offered tiers it shows, in the slot's order. Empty when hidden. */
  tiers: { family: NormalizedFamily; tier: NormalizedTier }[];
  /** No eligible product got an offer. Not shown to the customer. */
  hidden: boolean;
  /** Said to staff on Verify when hidden. */
  staff_note: string | null;
}

/**
 * What each slot shows, given what was offered.
 *
 * Best Match shows the first product in its list that got an offer. Side by
 * Side shows every product in its list that got an offer, together, as the
 * tiers of one decision. A slot with no offers is hidden from the customer and
 * explained to staff.
 */
export function resolveSlots(
  slots: TemplateSlot[],
  families: NormalizedFamily[],
  catalog: Map<string, SlotProduct>
): ResolvedSlot[] {
  const offered = new Map<string, { family: NormalizedFamily; tier: NormalizedTier }>();
  for (const family of families) {
    for (const tier of family.tiers) {
      offered.set(`${family.provider_id ?? ""}:${tier.product_code}`, { family, tier });
    }
  }

  // Every offered tier a slot lists by its product code. A tier listed by one
  // slot is that slot's, and no other slot takes it by category below.
  const listedKeys = new Set(
    slots.flatMap((sl) => sl.product_ids.map((id) => catalog.get(id)).filter((p): p is SlotProduct => !!p))
      .map((p) => `${p.provider_id}:${p.product_code}`)
  );

  return [...slots]
    .sort((a, b) => a.position - b.position)
    .map((slot) => {
      let found = slot.product_ids
        .map((id) => catalog.get(id))
        .filter((p): p is SlotProduct => !!p)
        .map((p) => offered.get(`${p.provider_id}:${p.product_code}`))
        .filter((x): x is { family: NormalizedFamily; tier: NormalizedTier } => !!x);
      // None of the slot's listed products was offered, but a product of the
      // slot's category was: another vehicle version of the same plan, under a
      // code the slot does not list (deal 15063: the ATV codes of Priority
      // Maintenance, where the slot lists the UTV ones). The provider rated
      // this vehicle, so the version it offered is the one that can be sold.
      // Service drive plans never come this far (rating-summary.ts,
      // pointOfSale), and are refused here too.
      if (found.length === 0 && slot.category) {
        found = [...offered.entries()]
          .filter(([key]) => !listedKeys.has(key))
          .map(([, x]) => x)
          .filter((x) => categoryOf({ ptype: x.family.family_code, name: x.tier.product_name }) === slot.category)
          .filter((x) => !isServiceDrivePlan(x.tier))
          .sort((a, b) => floorOf(b.tier) - floorOf(a.tier));
      }
      const tiers = slot.mode === "Best Match" ? found.slice(0, 1) : found;
      return {
        slot_id: slot.id,
        position: slot.position,
        title: slot.title,
        category: slot.category,
        mode: slot.mode,
        tiers,
        hidden: tiers.length === 0,
        staff_note:
          tiers.length === 0
            ? `${slot.title}: none of its ${slot.product_ids.length} products got an offer for this deal, so it is not shown.`
            : null,
      };
    });
}

/**
 * Offers no slot shows, one plain line per kind, for Details: "2 Maintenance
 * plans were offered but no menu row uses them." Never silent: an offer that
 * fits no row is said, not dropped.
 */
export function unplacedOffers(resolved: ResolvedSlot[], offered: NormalizedFamily[]): string[] {
  const shown = new Set(resolved.flatMap((s) => s.tiers.map((t) => `${t.family.provider_id ?? ""}:${t.tier.product_code}`)));
  const counts = new Map<string, number>();
  for (const family of offered) {
    for (const tier of family.tiers) {
      if (shown.has(`${family.provider_id ?? ""}:${tier.product_code}`)) continue;
      const kind = categoryOf({ ptype: family.family_code, name: tier.product_name }) ?? family.family_code;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([kind, n]) => unplacedNote(kind, n));
}

/** The cheapest thing a tier can be sold for, for ordering tiers. */
function floorOf(tier: NormalizedTier): number {
  const prices = tier.rates.map((r) => r.offered_price ?? r.dealer_cost).filter((p): p is number => p !== null);
  return prices.length > 0 ? Math.min(...prices) : Number.POSITIVE_INFINITY;
}

/**
 * The menu's decisions as families, one per shown slot, in the slot's order.
 *
 * A slot whose tiers all come from one family is that family, cut down to
 * those tiers in the family's own order (cheapest first): "All deals" turns
 * back into exactly the five families the planner has always shown. A slot
 * that gathers tiers from more than one family or provider becomes a family of
 * its own, its tiers cheapest first, each tier naming its provider. Hidden
 * slots are left out.
 */
export function slotFamilies(resolved: ResolvedSlot[]): NormalizedFamily[] {
  const out: NormalizedFamily[] = [];
  for (const slot of resolved) {
    if (slot.hidden) continue;
    const families = new Set(slot.tiers.map((t) => t.family));
    if (families.size === 1) {
      const family = slot.tiers[0].family;
      const keep = new Set(slot.tiers.map((t) => t.tier.product_code));
      out.push({ ...family, tiers: family.tiers.filter((t) => keep.has(t.product_code)) });
      continue;
    }
    out.push({
      family_code: `slot-${slot.position}`,
      provider_id: null,
      provider_name: null,
      tiers: slot.tiers
        .map(({ family, tier }) => ({ ...tier, provider_id: family.provider_id, provider_name: family.provider_name }))
        .sort((a, b) => floorOf(a) - floorOf(b)),
    });
  }
  return out;
}

