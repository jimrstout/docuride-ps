// components/SubmitSummary.tsx: what the Submit confirmation shows.
//
// The deal, the buyer, the sale date at the store, and a row per product with
// its vendor, term and customer price, then the total. Every figure is one the
// submit sends: fni-session-verify builds them with the same rows and the same
// function as fni-contract-submit (supabase/functions/_shared/saved-selections.ts).
// Nothing here adds or rounds anything.
//
// No hooks, so a Node test can render it. The modal around it is
// components/SubmitConfirm.tsx.

import { money } from "@/lib/money";
import type { PartyChange, SubmitConfirmation } from "@/lib/types";

/** "36 months, 36,000 miles", or "No term" when the product has none. */
export function termText(line: { term_months: number | null; term_miles: number | null }): string {
  const parts = [
    line.term_months ? `${line.term_months} months` : null,
    line.term_miles ? `${line.term_miles.toLocaleString("en-US")} miles` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "No term";
}

export default function SubmitSummary({
  confirmation,
  changes,
  note = null,
  titleId,
}: {
  confirmation: SubmitConfirmation;
  changes: PartyChange[];
  /** Said above the products: an out-of-date rating on a test session. */
  note?: string | null;
  titleId: string;
}) {
  const c = confirmation;
  return (
    <>
      <h2 id={titleId} className="vconfirm-title">Submit these contracts?</h2>
      <dl className="vconfirm-deal">
        <div>
          <dt>Deal</dt>
          <dd>{c.deal_number ?? "No number"}</dd>
        </div>
        <div>
          <dt>Buyer</dt>
          <dd>{c.buyer_name ?? "Not set"}</dd>
        </div>
        <div>
          <dt>Sale date</dt>
          <dd>{c.sale_date_label ?? "Not set"}</dd>
        </div>
      </dl>
      {note ? <p className="vsubmit-note vconfirm-stale">{note}</p> : null}
      <ul className="vconfirm-lines" aria-label="Products">
        {c.lines.map((l) => (
          <li key={l.rate_unique} className="vconfirm-line">
            <span className="vconfirm-name">{l.product_name}</span>
            <span className="vconfirm-price">{money(l.customer_price)}</span>
            <span className="vconfirm-meta">
              {l.vendor ?? "Provider not named"}, {termText(l)}
            </span>
          </li>
        ))}
      </ul>
      <p className="vconfirm-total">
        <span>Total customer price</span>
        <strong>{money(c.total)}</strong>
      </p>
      {c.test_at_maximum ? (
        <p className="vconfirm-note">
          This is a test session. The test server is sent each product at the most the provider allows,
          not these prices.
        </p>
      ) : null}
      {changes.length > 0 ? (
        <div className="vconfirm-changes">
          <p className="vconfirm-changes-head">Changed on Details</p>
          <ul className="vdx1-list">
            {changes.map((ch) => (
              <li key={ch.key}>
                <strong>{ch.label}</strong>: {ch.was ?? "not set"} to {ch.now ?? "removed"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
