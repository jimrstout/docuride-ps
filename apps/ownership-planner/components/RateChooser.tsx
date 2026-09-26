// How long, and what deductible.
//
// A product carries several rates. For most that is only a length: Tire & Wheel
// runs 24, 36, 48 and 60 months. For the two service contracts it is a length
// AND a deductible, twelve rates in all, which is four times three rather than
// twelve unrelated things.
//
// So it is drawn as two rows rather than a twelve-cell grid: four choices then
// three, seven controls, and the price above moves the moment either changes.
// Nothing is folded behind a disclosure, matching the rest of these screens.
//
// Mileage is deliberately absent. termMiles is 0 on every powersports rate, and
// a line reading "0 miles" tells a customer less than no line at all. It appears
// only when a rate actually carries one.

"use client";

import type { OfferRate } from "@/lib/types";

/**
 * The deductible, as a chip label.
 *
 * Doubles as the identity of the deductible axis: two rates with the same label
 * are the same deductible choice at different lengths, which is how the two rows
 * below stay in step with each other. "Disappearing" is part of the label rather
 * than a separate mark, because $100 disappearing and $100 flat are genuinely
 * different choices and must not collapse into one chip.
 */
function deductibleLabel(r: OfferRate): string {
  if (r.deductible === null) return "None";
  return r.disappearing_deductible ? `$${r.deductible} disappearing` : `$${r.deductible}`;
}

function monthsLabel(months: number | null): string {
  if (months === null) return "Term";
  if (months % 12 === 0 && months >= 12) {
    const years = months / 12;
    return years === 1 ? "1 year" : `${years} years`;
  }
  return `${months} months`;
}

export default function RateChooser({
  rates,
  chosen,
  onChoose,
}: {
  rates: OfferRate[];
  /**
   * The rate in force. The planner defaults it to the shortest term and the
   * smallest deductible, so in practice this is always set; undefined is
   * tolerated rather than expected.
   */
  chosen: OfferRate | undefined;
  onChoose: (rateUniqueId: string) => void;
}) {
  if (rates.length < 2) return null;

  // The axes, in the provider's own order as the normalizer sorted them:
  // shortest first, smallest deductible first.
  const months = [...new Set(rates.map((r) => r.term_months))];
  const deductibles = [...new Set(rates.map((r) => deductibleLabel(r)))];

  const hasDeductibleChoice = deductibles.length > 1;

  /** The rate matching a length, keeping the deductible the customer already
   *  chose where that combination exists. */
  function rateFor(m: number | null, dLabel: string | null): OfferRate | undefined {
    const inLength = rates.filter((r) => r.term_months === m);
    if (!dLabel) return inLength[0];
    return inLength.find((r) => deductibleLabel(r) === dLabel) ?? inLength[0];
  }

  const chosenDeductible = chosen ? deductibleLabel(chosen) : null;

  return (
    <div className="rates">
      <fieldset className="rate-axis">
        <legend>How long do you want it?</legend>
        <div className="rate-row" role="radiogroup" aria-label="Length of cover">
          {months.map((m) => {
            const target = rateFor(m, chosenDeductible);
            const on = chosen?.term_months === m;
            return (
              <button
                key={String(m)}
                type="button"
                role="radio"
                aria-checked={on}
                className={`chip ${on ? "is-on" : ""}`}
                disabled={!target}
                onClick={() => target && onChoose(target.rate_unique_id)}
              >
                {monthsLabel(m)}
              </button>
            );
          })}
        </div>
      </fieldset>

      {hasDeductibleChoice ? (
        <fieldset className="rate-axis">
          <legend>Deductible</legend>
          <div className="rate-row" role="radiogroup" aria-label="Deductible">
            {deductibles.map((d) => {
              const target = rates.find(
                (r) => r.term_months === (chosen?.term_months ?? months[0]) && deductibleLabel(r) === d
              );
              const on = chosenDeductible === d;
              return (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`chip ${on ? "is-on" : ""}`}
                  disabled={!target}
                  onClick={() => target && onChoose(target.rate_unique_id)}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}
