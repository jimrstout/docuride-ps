// Which level of cover, or none.
//
// Platinum, Gold, Silver and Bronze are tiers of one product, so they belong on
// one screen as one choice. Presented as a list of two or more they would read
// as separate products a customer could buy together, which is both nonsense and
// the kind of thing that gets sold by accident.
//
// Cheapest first, because a tier list reads upwards and because leading with the
// most expensive option is a pressure pattern this planner does not use.
//
// "I'll manage this" is not here. It lives in DecisionControl, alongside
// Include, because declining the whole family is a different question from
// choosing between its levels.

"use client";

import { money } from "@/lib/money";

export default function TierChooser({
  tiers,
  chosen,
  onChoose,
}: {
  tiers: { product_code: string; label: string; fromPrice: number | null }[];
  chosen: string | undefined;
  onChoose: (productCode: string) => void;
}) {
  if (tiers.length < 2) return null;

  return (
    <fieldset className="tiers">
      <legend>Which level of cover?</legend>
      <div className="tiers-row" role="radiogroup" aria-label="Level of cover">
        {tiers.map((t) => {
          const on = chosen === t.product_code;
          return (
            <button
              key={t.product_code}
              type="button"
              role="radio"
              aria-checked={on}
              className={`tier ${on ? "is-on" : ""}`}
              onClick={() => onChoose(t.product_code)}
            >
              <span className="tier-name">{t.label}</span>
              {t.fromPrice !== null ? (
                <span className="tier-price">{money(t.fromPrice)}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
