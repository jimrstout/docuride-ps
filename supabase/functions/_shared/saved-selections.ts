// _shared/saved-selections.ts
//
// The customer's planner choices, as fni-contract-submit takes them. A saved
// selection names the product and rate the way the rated quote does
// (provider_product_id is the quote's product unique, rate_unique_id its rate
// unique), so it can be found in the quote again. Pure, so a Node test holds it.

import type { ProductSelection } from "./offer-selections.ts";

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
