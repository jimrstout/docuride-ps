// The options that change what a product costs.
//
// A lift kit or oversized tires are part of configuring the plan, not a
// separate form bolted underneath it, so they sit with the product and the
// price above them moves the moment one is ticked. Each states its own cost,
// because an option that silently adds to the total is the thing a customer
// discovers at signing.

"use client";

import { money } from "@/lib/money";
import type { SurchargeOption } from "@/lib/types";

export default function ProductConfigurator({
  productCode,
  productName,
  options,
  chosen,
  onToggle,
}: {
  productCode: string;
  productName: string;
  options: SurchargeOption[];
  chosen: string[];
  onToggle: (code: string, on: boolean) => void;
}) {
  if (options.length === 0) return null;

  return (
    <fieldset className="config">
      <legend>Does any of this apply to your machine?</legend>
      {options.map((o) => {
        const id = `${productCode}-${o.code}`;
        return (
          <div className="config-row" key={o.code}>
            <input
              id={id}
              type="checkbox"
              checked={chosen.includes(o.code)}
              onChange={(e) => onToggle(o.code, e.target.checked)}
            />
            <label htmlFor={id}>
              <span className="config-label">{o.label}</span>
              {o.cost_delta > 0 && (
                <span className="config-cost">
                  adds {money(o.cost_delta)}
                  <span className="sr-only"> to {productName}</span>
                </span>
              )}
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}
