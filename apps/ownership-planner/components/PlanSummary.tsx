// Everything the customer was shown, and what they decided about each.
//
// Every presented product appears, including the ones being managed by the
// customer -- this is the record of a presentation, and a record that lists
// only what was bought is not one. The two decisions read in the same words
// here as on the screen where they were made; the earlier build said "I'll
// manage this" on the button and printed "Not Selected" in the summary, which
// framed the customer's decision as a failure to act on the one page they take
// home.

import { money } from "@/lib/money";
import type { Disposition } from "@/lib/types";

export interface PlanLine {
  code: string;
  name: string;
  duration: string | null;
  price: number;
  disposition: Disposition | undefined;
}

export default function PlanSummary({ lines }: { lines: PlanLine[] }) {
  if (lines.length === 0) {
    return (
      <p className="summary-empty">
        No ownership plans are offered for this machine, so there was nothing
        here for you to decide.
      </p>
    );
  }

  return (
    <ul className="summary">
      {lines.map((l) => {
        const included = l.disposition === "Included";
        return (
          <li key={l.code} className="summary-line">
            <span className="summary-what">
              <b>{l.name}</b>
              <small>
                {l.duration}
                {included ? ` · ${money(l.price)}` : ""}
              </small>
            </span>
            <span className={`tag ${included ? "tag--in" : "tag--own"}`}>
              {l.disposition ?? "Not yet decided"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
