// One ownership option.
//
// Compact by default and expandable, because four full-height cards turned
// Care & Protection into several screens of scrolling and a customer who is
// scrolling is no longer deciding. What stays on the row is what a decision
// needs: what it is for, what it does, what it costs in total, what it adds to
// a payment, and how long it lasts. The rest -- coverage, exclusions,
// deductible, how to claim, transferability, full terms -- is one press away
// and is never required to make the two visible choices.
//
// The price is the total first and the monthly figure second, always with the
// duration beside it. A customer shown "$12/month" with no term cannot see
// that it is $720.

"use client";

import { money } from "@/lib/money";
import DecisionControl from "./DecisionControl";
import ProductConfigurator from "./ProductConfigurator";
import type { CatalogEntry, Disposition, OfferProduct } from "@/lib/types";

export interface Presentable {
  offer: OfferProduct;
  copy: CatalogEntry;
  price: number;
}

export default function ProductRow({
  item,
  price,
  perMonth,
  disposition,
  chosenOptions,
  open,
  onToggleOpen,
  onDecide,
  onOption,
}: {
  item: Presentable;
  /** Price including whatever options are ticked. */
  price: number;
  /** Null on a cash deal, or when the deal cannot produce a payment. */
  perMonth: number | null;
  disposition: Disposition | undefined;
  chosenOptions: string[];
  open: boolean;
  onToggleOpen: () => void;
  onDecide: (d: Disposition) => void;
  onOption: (code: string, on: boolean) => void;
}) {
  const { copy, offer } = item;
  const detailId = `detail-${offer.product_code}`;

  return (
    <article className={`product ${disposition ? "is-decided" : ""}`}>
      <div className="product-main">
        <div className="product-text">
          <h3 className="product-name">{copy.display_name}</h3>
          <p className="product-purpose">{copy.what_it_accomplishes}</p>
        </div>

        <p className="product-price">
          <span className="price-total">{money(price)}</span>
          {perMonth !== null && (
            <span className="price-month">about {money(perMonth)} a month</span>
          )}
          {copy.coverage_duration && (
            <span className="price-term">{copy.coverage_duration}</span>
          )}
        </p>
      </div>

      <ProductConfigurator
        productCode={offer.product_code}
        productName={copy.display_name}
        options={offer.surcharge_options}
        chosen={chosenOptions}
        onToggle={onOption}
      />

      <div className="product-actions">
        <DecisionControl
          name={`decision-${offer.product_code}`}
          value={disposition}
          onChange={onDecide}
          productName={copy.display_name}
        />
        <button
          type="button"
          className="expander"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={onToggleOpen}
        >
          {open ? "Hide the details" : "What's covered, what isn't"}
        </button>
      </div>

      {open && (
        <div className="product-detail" id={detailId}>
          <dl>
            <dt>What it covers</dt>
            <dd>{copy.what_it_covers}</dd>

            <dt>How long</dt>
            <dd>{copy.coverage_duration}</dd>

            <dt>What it doesn&apos;t cover</dt>
            <dd>{copy.what_it_excludes}</dd>

            {copy.deductible_note && (<><dt>Deductible</dt><dd>{copy.deductible_note}</dd></>)}
            {offer.deductible !== null && (<><dt>Your deductible</dt><dd>{money(offer.deductible)}</dd></>)}

            <dt>How to use it</dt>
            <dd>{copy.how_to_use}</dd>

            <dt>If you sell it</dt>
            <dd>
              {copy.transferable ? "Transferable to the next owner." : "Not transferable."}
              {copy.transfer_note ? ` ${copy.transfer_note}` : ""}
            </dd>

            {copy.future_value_note && (<><dt>Down the road</dt><dd>{copy.future_value_note}</dd></>)}

            {copy.full_terms_url && (
              <>
                <dt>Full terms</dt>
                <dd>
                  <a href={copy.full_terms_url} target="_blank" rel="noreferrer noopener">
                    Read the complete contract
                  </a>
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </article>
  );
}
