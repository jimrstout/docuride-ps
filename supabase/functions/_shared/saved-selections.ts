// _shared/saved-selections.ts
//
// The customer's planner choices, as fni-contract-submit takes them. A saved
// selection names the product and rate the way the rated quote does
// (provider_product_id is the quote's product unique, rate_unique_id its rate
// unique), so it can be found in the quote again. Pure, so a Node test holds it.

import type { ProductSelection } from "./offer-selections.ts";
import { RECORDED_BY_STAFF } from "./oem-contracts.ts";

export interface SavedSelection {
  provider_product_id: string;
  rate_unique_id: string;
  selected_options: unknown;
  customer_price: number | string | null;
  retail_price: number | string | null;
}

export function savedSelections(rows: SavedSelection[]): ProductSelection[] {
  return rows
    .filter((r) => r.provider_product_id && r.rate_unique_id)
    .map((r) => ({
      product_unique: String(r.provider_product_id),
      rate_unique: String(r.rate_unique_id),
      option_uniques: Array.isArray(r.selected_options) ? r.selected_options.map(String) : [],
      // The price the customer agreed to, to the cent.
      retail_price: Number(r.customer_price ?? r.retail_price ?? 0),
    }));
}

// ── What the Submit confirmation shows ────────────────────────────────────
//
// Details asks for a confirmation before anything is submitted, listing each
// product with its vendor, term and customer price, and the total. Those
// figures must be the ones the submit sends, not a second calculation. So the
// screen and fni-contract-submit read the same rows (SUBMIT_ROW_COLUMNS, the
// customer's Included choices) and the price on each line is the retail_price
// savedSelections puts in the submit's selections, to the cent.

/** The selected_products columns both the submit and its confirmation read. */
export const SUBMIT_ROW_COLUMNS =
  "provider_product_id, rate_unique_id, selected_options, customer_price, retail_price, " +
  "product_name, term_months, term_miles, providers(name, contract_method)";

export interface SubmitRow extends SavedSelection {
  product_name: string | null;
  term_months: number | null;
  term_miles: number | null;
  /** The product's provider record. */
  providers: { name: string | null; contract_method: string | null } | null;
}

export interface ConfirmLine {
  product_name: string;
  /** The provider record's name. */
  vendor: string | null;
  term_months: number | null;
  term_miles: number | null;
  /** The retail_price the submit sends for this product, in dollars. */
  customer_price: number;
  customer_price_cents: number;
  rate_unique: string;
}

export interface SubmitConfirmation {
  lines: ConfirmLine[];
  total: number;
  total_cents: number;
}

/**
 * The products the submit will send, with the price it sends for each and
 * their total. Summed in whole cents, so the total cannot drift by a penny.
 */
export function submitConfirmation(rows: SubmitRow[]): SubmitConfirmation {
  const lines: ConfirmLine[] = [];
  for (const row of rows) {
    if (row.providers?.contract_method === RECORDED_BY_STAFF) continue;
    const [selection] = savedSelections([row]);
    if (!selection) continue;
    const cents = Math.round(selection.retail_price * 100);
    lines.push({
      product_name: row.product_name ?? selection.product_unique,
      vendor: row.providers?.name ?? null,
      term_months: row.term_months,
      term_miles: row.term_miles,
      customer_price: cents / 100,
      customer_price_cents: cents,
      rate_unique: selection.rate_unique,
    });
  }
  const total_cents = lines.reduce((sum, l) => sum + l.customer_price_cents, 0);
  return { lines, total: total_cents / 100, total_cents };
}
