// components/DecisionRecord.tsx
//
// The last screen's promise kept: every plan shown, the decision on each, and
// the payment those decisions produce.
//
// The payment is the Payment Plan step's own figures, passed in from the same
// planTotals call, so the two screens cannot disagree about a cent.

import { money, type PlanTotals } from "@/lib/money";
import type { RecordGroup } from "@/lib/decision-record";

export default function DecisionRecord({
  groups,
  planTotal,
  totals,
  isCash,
}: {
  groups: RecordGroup[];
  /** Sum of the chosen plans' prices. */
  planTotal: number;
  /** The Payment Plan step's figures. Null when the deal has no payment. */
  totals: PlanTotals | null;
  isCash: boolean;
}) {
  if (groups.length === 0) {
    return (
      <p className="summary-empty">
        No ownership plans were offered for this machine, so there was nothing
        here for you to decide.
      </p>
    );
  }

  return (
    <div className="record">
      {groups.map((g) => (
        <section key={g.code} className="record-group" aria-label={g.position}>
          <p className="record-head">
            <span>{g.goal}</span>
            <span>{g.position}</span>
          </p>
          <ul className="summary">
            {g.lines.map((l) => (
              <li key={l.code} className="summary-line" data-decision={l.decision}>
                <span className="summary-what">
                  <b>{l.name}</b>
                  {l.term ? <small>{l.term}</small> : null}
                </span>
                {l.chosen ? (
                  <span className="record-price">
                    <b>{l.price === null ? "Ask us" : money(l.price)}</b>
                    <small>Chosen</small>
                  </span>
                ) : (
                  <span className="tag tag--own">{l.decision}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <dl className="figure-split record-totals">
        <div>
          <dt>Protection chosen</dt>
          <dd>{money(planTotal)}</dd>
        </div>
        {totals ? (
          <>
            <div>
              <dt>Monthly payment without protection</dt>
              <dd>{money(totals.vehiclePayment)}</dd>
            </div>
            <div className="is-total">
              <dt>Monthly payment with protection</dt>
              <dd>{money(totals.totalPayment)}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>Monthly payment</dt>
            <dd>{isCash ? "None, paid outright" : "Not finalized yet"}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
