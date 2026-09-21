// What the plan adds to a deal that is already structured.
//
// Both figures, always: the total the products cost and what they do to the
// payment. Showing only the monthly delta is how a $3,000 plan gets sold as
// "about sixty dollars", and showing only the total hides what the customer
// will actually feel each month. Neither alone is honest.
//
// The arithmetic is not done here. planTotals() computes the total from the
// combined financed amount, the way the contract will, rather than by summing
// rounded per-product payments -- those drift a few cents, and a summary that
// does not reconcile against the contract is worse than no summary.

import { money } from "@/lib/money";
import type { PlanTotals } from "@/lib/money";

export function PaymentBreakdown({ totals }: { totals: PlanTotals }) {
  return (
    <div className="figures">
      <p className="figure figure--hero">
        <span className="figure-label">Total monthly payment</span>
        <strong className="figure-value">{money(totals.totalPayment)}</strong>
      </p>
      <dl className="figure-split">
        <div><dt>Vehicle</dt><dd>{money(totals.vehiclePayment)}</dd></div>
        <div><dt>Your ownership plan</dt><dd>{money(totals.planPayment)}</dd></div>
        <div className="is-total"><dt>Total</dt><dd>{money(totals.totalPayment)}</dd></div>
      </dl>
    </div>
  );
}

export function PlanCostOnly({
  label,
  total,
  lines,
}: {
  label: string;
  total: number;
  lines: { name: string; amount: number }[];
}) {
  return (
    <div className="figures">
      <p className="figure figure--hero">
        <span className="figure-label">{label}</span>
        <strong className="figure-value">{money(total)}</strong>
      </p>
      {lines.length > 0 && (
        <dl className="figure-split">
          {lines.map((l) => (
            <div key={l.name}><dt>{l.name}</dt><dd>{money(l.amount)}</dd></div>
          ))}
          <div className="is-total"><dt>Total</dt><dd>{money(total)}</dd></div>
        </dl>
      )}
    </div>
  );
}

export function DealTerms({
  principal,
  term,
  rateLabel,
  rate,
}: {
  principal: number | null;
  term: number | null;
  rateLabel: string;
  rate: number | null;
}) {
  return (
    <dl className="terms">
      <div><dt>Amount financed</dt><dd>{principal !== null ? money(principal) : "—"}</dd></div>
      <div><dt>Term</dt><dd>{term !== null ? `${term} months` : "—"}</dd></div>
      <div><dt>{rateLabel}</dt><dd>{rate !== null ? `${rate}%` : "—"}</dd></div>
    </dl>
  );
}
