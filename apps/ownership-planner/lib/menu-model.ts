// lib/menu-model.ts: the conventional menu's rows, cells and choices.
//
// The menu is a grid. Rows are the families the deal was offered, the same
// list and order as the Ownership Planner, with nothing filtered: every rated
// product appears in every column. Columns are the menu template's packages
// (supabase/functions/_shared/menu-columns.ts). A cell is one product in one
// column: checked or not, and its own level, term, deductible and options.
//
//   no approved description   shown under the provider's product name
//   no price                  shown as not available, and cannot be checked
//   purchased                 checked, at the price it was sold for, locked
//                             (lib/purchased.ts)
//
// A cell starts checked when its family's category is one of the column's
// presets, at the column's coverage level (Lowest, Middle or Highest of the
// family's priced levels, cheapest first), on the planner's defaults for the
// rest: the shortest term and smallest deductible (the tier's first rate), and
// no optional surcharges. A mandatory surcharge is always counted. Changing a
// cell changes that column only.
//
// "Select this package" saves the same rows the planner saves, one per tier:
// Included for the chosen tier of each checked family in that column, Managed
// by Customer for every other tier, so Submit works unchanged.
//
// No imports, so a Node test can load it. The payment is planTotals
// (lib/money.ts), called by the screen on each column's prices.

export type Level = "Lowest" | "Middle" | "Highest";

export interface MenuColumnSpec {
  name: string;
  preset_categories: string[];
  starting_level: Level;
}

export interface MenuOption {
  code: string;
  label: string;
  cost_delta: number;
  mandatory: boolean;
}

export interface MenuRate {
  rate_unique_id: string;
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  dealer_cost: number | null;
  retail_price: number | null;
  options: MenuOption[];
  raw: Record<string, unknown>;
}

export interface MenuOfferTier {
  product_code: string;
  product_name: string;
  product_type: string;
  rates: MenuRate[];
  raw: Record<string, unknown>;
  provider_id?: string | null;
}

export interface MenuOfferFamily {
  family_code: string;
  provider_id: string | null;
  tiers: MenuOfferTier[];
}

export interface MenuCatalogEntry {
  provider_id: string | null;
  product_code: string;
  category: string | null;
  display_name: string;
  is_presentable: boolean;
}

export interface SavedRow {
  provider_id: string | null;
  provider_product_id: string;
  rate_unique_id: string | null;
  selected_options: unknown;
  customer_price?: string | number | null;
  retail_price?: string | number | null;
}

export interface RowTier {
  product_code: string;
  provider_id: string | null;
  /** The approved display name, or the provider's product name without one. */
  name: string;
  product_type: string;
  /** Only the priced rates: a rate with no price cannot be sold. */
  rates: MenuRate[];
  fromPrice: number | null;
  available: boolean;
  raw: Record<string, unknown>;
}

export interface MenuRow {
  family_code: string;
  provider_id: string | null;
  label: string;
  category: string | null;
  /** Cheapest first; tiers with no price last. */
  tiers: RowTier[];
  /** Under a live contract: locked to this tier, at this price. */
  purchased: { product_code: string; price: number | null; rate_unique_id: string | null; options: string[] } | null;
}

export interface Cell {
  checked: boolean;
  tier: string;
  rate: string | null;
  options: string[];
}

export const UNAVAILABLE = "Not available";
export const PURCHASED = "Purchased";

const key = (provider: string | null | undefined, code: string) => `${provider ?? ""}:${code}`;

function priceOf(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Which tier a level picks, of `count` tiers cheapest first. The same rule as _shared/menu-columns.ts. */
export function levelIndex(level: Level, count: number): number {
  if (count <= 1) return 0;
  if (level === "Lowest") return 0;
  if (level === "Highest") return count - 1;
  return Math.floor((count - 1) / 2);
}

/** The surcharges on a rate: every mandatory one, and each one chosen. */
export function surchargeCost(rate: MenuRate, chosen: string[]): number {
  return rate.options.filter((o) => o.mandatory || chosen.includes(o.code)).reduce((a, o) => a + o.cost_delta, 0);
}

/** The menu's rows: every offered family, every tier, nothing hidden. */
export function buildRows(
  families: MenuOfferFamily[],
  catalog: MenuCatalogEntry[],
  purchased: { provider_id: string | null; provider_product_id: string }[],
  saved: SavedRow[]
): MenuRow[] {
  const copy = new Map(catalog.map((c) => [key(c.provider_id, c.product_code), c]));
  const bought = new Set(purchased.map((p) => key(p.provider_id, p.provider_product_id)));
  const savedBy = new Map(saved.map((s) => [key(s.provider_id, s.provider_product_id), s]));

  return families.map((f) => {
    const tiers: RowTier[] = f.tiers.map((t) => {
      const provider = t.provider_id ?? f.provider_id;
      const c = copy.get(key(provider, t.product_code));
      const rates = t.rates.filter((r) => r.retail_price !== null);
      const fromPrice = rates.length > 0 ? Math.min(...rates.map((r) => r.retail_price as number)) : null;
      return {
        product_code: t.product_code,
        provider_id: provider,
        name: c && c.is_presentable && c.display_name ? c.display_name : t.product_name,
        product_type: t.product_type,
        rates,
        fromPrice,
        available: rates.length > 0,
        raw: t.raw,
      };
    });
    // Cheapest first, the way the planner orders levels; unpriced last.
    const ordered = tiers
      .map((t, i) => ({ t, i }))
      .sort((a, b) =>
        a.t.fromPrice === null && b.t.fromPrice === null ? a.i - b.i
        : a.t.fromPrice === null ? 1
        : b.t.fromPrice === null ? -1
        : a.t.fromPrice - b.t.fromPrice || a.i - b.i
      )
      .map((x) => x.t);

    const category =
      ordered.map((t) => copy.get(key(t.provider_id, t.product_code))?.category ?? null).find((c) => c !== null) ?? null;
    const boughtTier = ordered.find((t) => bought.has(key(t.provider_id, t.product_code))) ?? null;
    const row = boughtTier ? savedBy.get(key(boughtTier.provider_id, boughtTier.product_code)) : undefined;

    return {
      family_code: f.family_code,
      provider_id: f.provider_id,
      label: ordered.length === 1 || !category ? ordered[0]?.name ?? f.family_code : category,
      category,
      tiers: ordered,
      purchased: boughtTier
        ? {
            product_code: boughtTier.product_code,
            price: priceOf(row?.customer_price ?? row?.retail_price ?? null),
            rate_unique_id: row?.rate_unique_id ?? null,
            options: Array.isArray(row?.selected_options) ? (row!.selected_options as unknown[]).map(String) : [],
          }
        : null,
    };
  });
}

/** A cell as the column starts it. */
export function initialCell(row: MenuRow, column: MenuColumnSpec): Cell {
  if (row.purchased) {
    return { checked: true, tier: row.purchased.product_code, rate: row.purchased.rate_unique_id, options: row.purchased.options };
  }
  const available = row.tiers.filter((t) => t.available);
  if (available.length === 0) return { checked: false, tier: row.tiers[0]?.product_code ?? "", rate: null, options: [] };
  const tier = available[levelIndex(column.starting_level, available.length)];
  return {
    checked: row.category !== null && column.preset_categories.includes(row.category),
    tier: tier.product_code,
    rate: tier.rates[0]?.rate_unique_id ?? null,
    options: [],
  };
}

export function initialCells(rows: MenuRow[], columns: MenuColumnSpec[]): Cell[][] {
  return columns.map((c) => rows.map((r) => initialCell(r, c)));
}

/** A column's choice per category from Prepare menu, or the presets (fni-session-get menu_prepared). */
export interface MenuPrepared {
  cells: Record<string, Record<string, { provider_id: string; product_code: string; rate_unique_id: string } | null>>;
  surcharges: string[];
}

/**
 * The columns as prepared (docs section 25): each row checked when its
 * category's choice in that column is one of its plans, on that rate, with
 * the deal's surcharges the rate offers. A purchased row stays as it is.
 * Without a prepared menu, the columns' own rule (initialCells).
 */
export function preparedCells(rows: MenuRow[], columns: MenuColumnSpec[], prepared: MenuPrepared | null | undefined): Cell[][] {
  if (!prepared) return initialCells(rows, columns);
  return columns.map((column, i) =>
    rows.map((row) => {
      if (row.purchased) return initialCell(row, column);
      const choice = row.category ? prepared.cells[String(i + 1)]?.[row.category] ?? null : null;
      const tier = choice ? row.tiers.find((t) => t.product_code === choice.product_code && t.available) : undefined;
      const rate = tier?.rates.find((r) => r.rate_unique_id === choice!.rate_unique_id);
      if (!tier || !rate) return { ...initialCell(row, column), checked: false };
      const offered = new Set(rate.options.filter((o) => !o.mandatory).map((o) => o.code));
      return { checked: true, tier: tier.product_code, rate: rate.rate_unique_id, options: prepared.surcharges.filter((c) => offered.has(c)) };
    })
  );
}

export function tierOf(row: MenuRow, cell: Cell): RowTier | undefined {
  return row.tiers.find((t) => t.product_code === cell.tier) ?? row.tiers[0];
}

export function rateOf(row: MenuRow, cell: Cell): MenuRate | undefined {
  const t = tierOf(row, cell);
  return t?.rates.find((r) => r.rate_unique_id === cell.rate) ?? t?.rates[0];
}

/** Whether a cell can be changed at all. */
export function cellLocked(row: MenuRow): boolean {
  return row.purchased !== null;
}

export function cellAvailable(row: MenuRow): boolean {
  return row.purchased !== null || row.tiers.some((t) => t.available);
}

/** What a cell costs as configured, or null when it cannot be priced. */
export function cellPrice(row: MenuRow, cell: Cell): number | null {
  if (row.purchased && row.purchased.price !== null) return row.purchased.price;
  const t = tierOf(row, cell);
  const r = rateOf(row, cell);
  if (!t?.available || !r || r.retail_price === null) return null;
  return r.retail_price + surchargeCost(r, cell.options);
}

/** The prices of a column's checked products, for planTotals. */
export function columnPrices(rows: MenuRow[], cells: Cell[]): number[] {
  return rows
    .map((row, i) => (cells[i]?.checked ? cellPrice(row, cells[i]) : null))
    .filter((p): p is number => p !== null);
}

/** Every product unchecked, except what is already purchased. */
export function declinedCells(rows: MenuRow[], cells: Cell[]): Cell[] {
  return rows.map((row, i) => (row.purchased ? cells[i] : { ...cells[i], checked: false }));
}

/** The rows fni-session-save writes, the same shape the planner sends. */
export function saveDecisions(rows: MenuRow[], cells: Cell[], presentedAt: string) {
  return rows.flatMap((row, i) => {
    const cell = cells[i];
    const included = cell.checked && cellPrice(row, cell) !== null;
    return row.tiers.map((t) => {
      const chosen = included && t.product_code === cell.tier;
      const rate = chosen ? rateOf(row, cell) : t.rates[0];
      const options = chosen ? cell.options : [];
      const price = chosen
        ? cellPrice(row, cell)
        : rate && rate.retail_price !== null ? rate.retail_price + surchargeCost(rate, options) : null;
      return {
        provider_id: t.provider_id ?? row.provider_id,
        product_code: t.product_code,
        product_type: t.product_type,
        product_name: t.name,
        disposition: chosen ? "Included" : "Managed by Customer",
        rate_unique_id: rate?.rate_unique_id ?? null,
        term_months: rate?.term_months ?? null,
        term_miles: rate?.term_miles ?? null,
        deductible: rate?.deductible ?? null,
        dealer_cost: rate?.dealer_cost ?? null,
        retail_price: price,
        customer_price: price,
        selected_options: options,
        rate_snapshot: rate?.raw ?? t.raw,
        presented_at: presentedAt,
      };
    });
  });
}

/**
 * What a cell says beside its checkbox, short enough to read at a glance: a
 * level's own word ("Gold", "Level 2") with what every level of the product
 * shares taken off, or for a product with one level, its term.
 */
export function cellCaption(row: MenuRow, cell: Cell): string {
  const t = tierOf(row, cell);
  if (!t) return "";
  if (row.tiers.length > 1) {
    const words = row.tiers.map((x) => x.name.split(/\s+/));
    let shared = 0;
    while (words.every((w) => w[shared] !== undefined && w[shared].toLowerCase() === words[0][shared].toLowerCase())) shared++;
    // Keep the word before a short leftover, so "Level 2" rather than "2".
    const mine = t.name.split(/\s+/);
    let from = Math.min(shared, mine.length);
    if (from > 0 && mine.slice(from).join(" ").length < 3) from--;
    const own = mine.slice(from).join(" ");
    return own || t.name;
  }
  const r = rateOf(row, cell);
  if (!r) return "";
  return [r.term_months ? `${r.term_months} months` : null, r.term_miles ? `${r.term_miles.toLocaleString("en-US")} miles` : null]
    .filter(Boolean)
    .join(", ");
}
