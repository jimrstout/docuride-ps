// lib/prepare-model.ts: the arithmetic of Prepare menu, on the staff side.
//
// The sheet comes from fni-menu-prepare (supabase/functions/_shared/
// menu-prepare.ts). Here is what the screen works out as staff change it:
//
//   - A price belongs to the option (its key), not the cell, so editing it in
//     one column changes it in every column that offers the same option.
//   - The customer pays the option's price, plus what it always carries
//     (mandatory options), plus each surcharge chosen for the deal that it
//     offers. Surcharges are set once for the deal and apply in every column.
//   - Each column's footer: its total, its profit, and its monthly payment,
//     by the same rules as the menu (lib/money.ts planTotals).
//
// All money in cents. No imports, so a Node test can load it: the payment is
// worked out by a function the screen passes in (lib/money.ts planTotals).

export interface Band { floor: number; top: number }

export interface SheetOption {
  key: string;
  label: string;
  rate_unique_id: string;
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  disappearing_deductible: boolean;
  dealer_cost: number;
  surcharge_cost: number;
  rule_price: number | null;
  price: number | null;
  band: Band;
  above_band: boolean;
  approved_by: string | null;
  reason: string | null;
  surcharge_codes: string[];
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

export interface PrepareSheet {
  columns: { position: number; name: string }[];
  categories: string[];
  plans: Record<string, SheetPlan[]>;
  cells: Record<string, Record<string, { key: string | null; note: string | null }>>;
  surcharges: { available: { code: string; label: string }[]; chosen: string[] };
  prepared: boolean;
  purchased: { category: string; plan_name: string; price: number }[];
}

export interface PreparePayload {
  session: { id: string; deal_number: string | null; vehicle: string; prepared_at: string | null; prepared_by: string | null; locked_at: string | null };
  out_of_date: boolean;
  payment: { has_payment: boolean; principal: number | null; rate: number | null; term_months: number | null; cap: number | null };
  sheet: PrepareSheet;
}

/** What staff have on screen. */
export interface PrepareState {
  cells: Record<string, Record<string, string | null>>;
  /** Cents per option key, for the prices staff typed. */
  prices: Record<string, number>;
  surcharges: string[];
}

export function initialState(sheet: PrepareSheet): PrepareState {
  const cells: PrepareState["cells"] = {};
  for (const [pos, row] of Object.entries(sheet.cells)) {
    cells[pos] = Object.fromEntries(Object.entries(row).map(([cat, c]) => [cat, c.key]));
  }
  return { cells, prices: {}, surcharges: [...sheet.surcharges.chosen] };
}

export function findOption(sheet: PrepareSheet, key: string | null): { category: string; plan: SheetPlan; option: SheetOption } | null {
  if (!key) return null;
  for (const [category, list] of Object.entries(sheet.plans)) {
    for (const plan of list) {
      const option = plan.options.find((o) => o.key === key);
      if (option) return { category, plan, option };
    }
  }
  return null;
}

/** The option's price on screen, before surcharges: what staff typed, or the sheet's. */
export function priceOf(o: SheetOption, state: PrepareState): number | null {
  return state.prices[o.key] ?? o.price;
}

/** What the option's surcharges cost on this deal, as chosen on screen. */
export function surchargesOf(o: SheetOption, state: PrepareState): number {
  return o.mandatory_cost + state.surcharges.reduce((n, c) => n + (o.option_costs[c] ?? 0), 0);
}

export interface CellFigures {
  dealer_cost: number;
  price: number | null;
  profit: number | null;
  above_band: boolean;
  below_floor: boolean;
}

/** Dealer cost and price both carry the surcharges, which pass through at cost. */
export function cellFigures(o: SheetOption, state: PrepareState): CellFigures {
  const extra = surchargesOf(o, state);
  const price = priceOf(o, state);
  return {
    dealer_cost: o.dealer_cost + extra,
    price: price === null ? null : price + extra,
    profit: price === null ? null : price - o.dealer_cost,
    above_band: price !== null && price > o.band.top,
    below_floor: price !== null && (price < o.band.floor || price < o.dealer_cost),
  };
}

export interface ColumnFigures {
  total: number;
  profit: number;
  /** Cents a month for the protection, or null on a cash deal. */
  monthly: number | null;
}

/**
 * A column's footer: its cells and the purchased products, in every column.
 * `monthlyOf` takes the column's prices in dollars and gives the protection's
 * payment in dollars, or null on a cash deal.
 */
export function columnFigures(
  sheet: PrepareSheet,
  state: PrepareState,
  pos: string,
  monthlyOf: (prices: number[]) => number | null
): ColumnFigures {
  const prices: number[] = sheet.purchased.map((p) => p.price);
  let profit = 0;
  for (const key of Object.values(state.cells[pos] ?? {})) {
    const found = findOption(sheet, key);
    if (!found) continue;
    const f = cellFigures(found.option, state);
    if (f.price === null) continue;
    prices.push(f.price);
    profit += f.profit ?? 0;
  }
  const total = prices.reduce((a, p) => a + p, 0);
  const m = monthlyOf(prices.map((p) => p / 100));
  return { total, profit, monthly: m === null ? null : Math.round(m * 100) };
}

/** What Prepare menu sends: only the prices staff changed from the sheet's. */
export function payloadOf(sheet: PrepareSheet, state: PrepareState): { cells: PrepareState["cells"]; prices: Record<string, number>; surcharges: string[] } {
  const prices: Record<string, number> = {};
  for (const [key, cents] of Object.entries(state.prices)) {
    const o = findOption(sheet, key)?.option;
    if (o && cents !== o.price) prices[key] = cents;
  }
  return { cells: state.cells, prices, surcharges: state.surcharges };
}

/** Whether a manager must sign in: any price on screen above its band. */
export function needsManager(sheet: PrepareSheet, state: PrepareState): string[] {
  return Object.entries(state.prices)
    .filter(([key, cents]) => {
      const o = findOption(sheet, key)?.option;
      return !!o && cents !== o.price && cents > o.band.top;
    })
    .map(([key]) => key);
}

/** "$1,234.56" from cents. */
export function dollars(cents: number | null): string {
  if (cents === null) return "Not priced";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "450.00" typed or "$1,200" read as cents, or null when it is not money. */
export function readCents(typed: string): number | null {
  const s = typed.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}
