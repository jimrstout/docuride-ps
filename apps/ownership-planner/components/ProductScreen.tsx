// One family of cover, on a screen of its own.
//
// The list view asked a customer to hold four products in their head and scroll
// between them. A screen each means the thing being decided is the only thing
// on the page: its plain-language terms, its price, what it does to a payment,
// how long it lasts, and the two answers -- all visible at once, with no
// scrolling and nothing folded away behind a disclosure.
//
// ── A family, not a product (2026-09-26) ────────────────────────────────
// A real quote offers eleven products, and four of them are Platinum, Gold,
// Silver and Bronze: tiers of one thing. Eleven screens would have asked a
// customer to include or decline each separately, which invites buying Platinum
// and Gold together. So one screen asks one question per family, and the tier is
// a choice inside it.
//
// Length and deductible are a second choice inside that, for the products that
// offer more than one rate. Both sit above the decision, because the price the
// customer is deciding about depends on them.
//
// Continue stays disabled until one of the two answers is chosen. That is not a
// nag: skipping past a product would record "Managed by Customer" for something
// the customer never actually saw a decision about, and the record of what was
// presented is the point of this whole exercise.

"use client";

import { money } from "@/lib/money";
import DecisionControl from "./DecisionControl";
import ProductConfigurator from "./ProductConfigurator";
import RateChooser from "./RateChooser";
import TierChooser from "./TierChooser";
import { durationOf, renderTemplate, TEMPLATE_DISAPPEARING_DEDUCTIBLE } from "@/lib/copy";
import type { CatalogEntry, Disposition, OfferRate, OfferTier } from "@/lib/types";

/** A tier that can honestly be shown: it has approved copy and a sellable rate. */
export interface PresentableTier {
  tier: OfferTier;
  copy: CatalogEntry;
  /** The cheapest sellable price across its rates, for the tier button. */
  fromPrice: number | null;
}

/** One screen: a family, its showable tiers, and the copy for whichever is chosen. */
export interface Presentable {
  family_code: string;
  tiers: PresentableTier[];
}

export default function ProductScreen({
  item,
  index,
  total,
  chosenTier,
  chosenRate,
  price,
  perMonth,
  disposition,
  chosenOptions,
  dealerGroupName,
  copyTemplates,
  onChooseTier,
  onChooseRate,
  onDecide,
  onOption,
}: {
  item: Presentable;
  /** 1-based, for "Option 2 of 5". */
  index: number;
  total: number;
  chosenTier: PresentableTier;
  chosenRate: OfferRate | undefined;
  price: number | null;
  /** Null on a cash deal, or when the deal cannot produce a payment. */
  perMonth: number | null;
  disposition: Disposition | undefined;
  chosenOptions: string[];
  dealerGroupName: string | null;
  copyTemplates: Record<string, string>;
  onChooseTier: (productCode: string) => void;
  onChooseRate: (rateUniqueId: string) => void;
  onDecide: (d: Disposition) => void;
  onOption: (code: string, on: boolean) => void;
}) {
  const { copy, tier } = chosenTier;

  // ── The deductible line ───────────────────────────────────────────────
  // Three cases, in order of how much they tell the customer:
  //
  //   A disappearing deductible gets the dealer group's sentence, with the
  //   amount from the rate rather than written into the wording. Dropped
  //   entirely if the group has no name set, because a sentence with a gap in
  //   it is worse than no sentence.
  //
  //   A plain deductible gets the amount.
  //
  //   Otherwise the catalog's note, which explains what a deductible is rather
  //   than stating one.
  //
  // The fall-through matters: a disappearing deductible whose sentence cannot
  // be completed drops to stating the plain amount, which is true, rather than
  // promising a $0 repair at a group this planner cannot name.
  const deductible = chosenRate?.deductible ?? null;

  let deductibleLine: string | null = null;
  if (chosenRate?.disappearing_deductible && deductible !== null) {
    deductibleLine = renderTemplate(copyTemplates[TEMPLATE_DISAPPEARING_DEDUCTIBLE], {
      deductible_amount: money(deductible),
      dealer_group_name: dealerGroupName,
    });
  }
  if (!deductibleLine && deductible !== null) deductibleLine = money(deductible);
  if (!deductibleLine && copy.deductible_note) deductibleLine = copy.deductible_note;

  // How long this cover lasts, from the chosen rate. Shared with the plan
  // summary so the two never disagree about the same choice.
  const durationLine = durationOf(chosenRate, copy.coverage_duration);

  // Only the terms this product actually has. An empty definition list row
  // reading "—" tells the customer nothing and costs the vertical space that
  // keeps the screen inside the viewport.
  const terms: [string, string][] = [];
  if (copy.what_it_covers) terms.push(["What it covers", copy.what_it_covers]);
  if (copy.what_it_excludes) terms.push(["What it doesn't cover", copy.what_it_excludes]);
  if (deductibleLine) terms.push(["Deductible", deductibleLine]);
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
        <TierChooser
          tiers={item.tiers.map((t) => ({
            product_code: t.tier.product_code,
            label: t.copy.display_name,
            fromPrice: t.fromPrice,
          }))}
          chosen={tier.product_code}
          onChoose={onChooseTier}
        />

        <RateChooser
          rates={tier.rates}
          chosen={chosenRate}
          onChoose={onChooseRate}
        />

        <div className="ps-price">
          <span className="ps-price-label">Price</span>
          <span className="ps-price-total">
            {price === null ? "Ask us" : money(price)}
          </span>
          {perMonth !== null && (
            <span className="ps-price-month">about {money(perMonth)} a month</span>
          )}
          {durationLine && <span className="ps-price-term">{durationLine}</span>}
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
          productCode={tier.product_code}
          productName={copy.display_name}
          options={chosenRate?.options ?? []}
          chosen={chosenOptions}
          onToggle={onOption}
        />

        <div className="ps-decide">
          <p className="ps-decide-ask">Is this part of your plan?</p>
          <DecisionControl
            name={`decision-${item.family_code}`}
            value={disposition}
            onChange={onDecide}
            productName={copy.display_name}
          />
        </div>
      </div>
    </div>
  );
}
