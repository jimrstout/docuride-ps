// One ownership option, on a screen of its own.
//
// The list view asked a customer to hold four products in their head and scroll
// between them. A screen each means the thing being decided is the only thing
// on the page: its plain-language terms, its price, what it does to a payment,
// how long it lasts, and the two answers -- all visible at once, with no
// scrolling and nothing folded away behind a disclosure.
//
// Continue stays disabled until one of the two is chosen. That is not a nag:
// skipping past a product would record "Managed by Customer" for something the
// customer never actually saw a decision about, and the record of what was
// presented is the point of this whole exercise.
//
// The counter says where they are in a finite list, because "Option 2 of 4"
// answers the question a customer asks when a screen replaces a list.

"use client";

import { money } from "@/lib/money";
import DecisionControl from "./DecisionControl";
import ProductConfigurator from "./ProductConfigurator";
import type { CatalogEntry, Disposition, OfferProduct } from "@/lib/types";

/** A product that can honestly be shown: it has a price and approved copy. */
export interface Presentable {
  offer: OfferProduct;
  copy: CatalogEntry;
  price: number;
}

export default function ProductScreen({
  item,
  index,
  total,
  price,
  perMonth,
  disposition,
  chosenOptions,
  onDecide,
  onOption,
}: {
  item: Presentable;
  /** 1-based, for "Option 2 of 4". */
  index: number;
  total: number;
  price: number;
  /** Null on a cash deal, or when the deal cannot produce a payment. */
  perMonth: number | null;
  disposition: Disposition | undefined;
  chosenOptions: string[];
  onDecide: (d: Disposition) => void;
  onOption: (code: string, on: boolean) => void;
}) {
  const { copy, offer } = item;

  // Only the terms this product actually has. An empty definition list row
  // reading "—" tells the customer nothing and costs the vertical space that
  // keeps the screen inside the viewport.
  const terms: [string, string][] = [];
  if (copy.what_it_covers) terms.push(["What it covers", copy.what_it_covers]);
  if (copy.what_it_excludes) terms.push(["What it doesn't cover", copy.what_it_excludes]);
  if (copy.deductible_note) terms.push(["Deductible", copy.deductible_note]);
  else if (offer.deductible !== null) terms.push(["Deductible", money(offer.deductible)]);
  if (copy.how_to_use) terms.push(["How to use it", copy.how_to_use]);
  terms.push([
    "If you sell it",
    (copy.transferable ? "Transferable to the next owner." : "Not transferable.") +
      (copy.transfer_note ? ` ${copy.transfer_note}` : ""),
  ]);
  if (copy.future_value_note) terms.push(["Down the road", copy.future_value_note]);

  return (
    <div className="pscreen">
      <div className="ps-main">
        <p className="eyebrow eyebrow--rule">
          <span className="ps-goal">{copy.goal}</span>
          <span className="ps-count">Option {index} of {total}</span>
        </p>

        <h1 className="display">{copy.display_name}</h1>
        <p className="ps-purpose">{copy.what_it_accomplishes}</p>

        <dl className="ps-terms">
          {terms.map(([dt, dd]) => (
            <div key={dt}>
              <dt>{dt}</dt>
              <dd>{dd}</dd>
            </div>
          ))}
        </dl>

      </div>

      <div className="ps-side">
        <div className="ps-price">
          <span className="ps-price-label">Price</span>
          <span className="ps-price-total">{money(price)}</span>
          {perMonth !== null && (
            <span className="ps-price-month">about {money(perMonth)} a month</span>
          )}
          {copy.coverage_duration && (
            <span className="ps-price-term">{copy.coverage_duration}</span>
          )}
          {copy.full_terms_url && (
            <a
              className="ps-full"
              href={copy.full_terms_url}
              target="_blank"
              rel="noreferrer noopener"
            >
              Read the complete contract
            </a>
          )}
        </div>

        <ProductConfigurator
          productCode={offer.product_code}
          productName={copy.display_name}
          options={offer.surcharge_options}
          chosen={chosenOptions}
          onToggle={onOption}
        />

        <div className="ps-decide">
          <p className="ps-decide-ask">Is this part of your plan?</p>
          <DecisionControl
            name={`decision-${offer.product_code}`}
            value={disposition}
            onChange={onDecide}
            productName={copy.display_name}
          />
        </div>
      </div>
    </div>
  );
}
