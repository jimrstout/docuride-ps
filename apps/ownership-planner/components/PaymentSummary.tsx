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

import { money, toCents } from "@/lib/money";
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

/**
 * What is due at signing, when the finance company's maximum matters.
 *
 * With an additional down payment: the agreed down payment, the additional
 * one, and the total due at signing, with one plain sentence saying why. With
 * none: the agreed down payment alone, and only if the deal has one. The
 * maximum itself is never printed.
 *
 * `forPlan` is false when the vehicle alone is already past the maximum, so the
 * additional amount is not all down to the protection chosen and must not be
 * described as if it were.
 */
export function DownPaymentSummary({
  agreed,
  additional,
  forPlan,
}: {
  agreed: number | null;
  additional: number;
  forPlan: boolean;
}) {
  if (!(additional > 0)) {
    if (agreed === null) return null;
    return (
      <dl className="figure-split figure-split--down">
        <div><dt>Agreed down payment</dt><dd>{money(agreed)}</dd></div>
      </dl>
    );
  }

  const total = toCents((agreed ?? 0) + additional);
  return (
    <div className="figures figures--down">
      <dl className="figure-split figure-split--down">
        {agreed !== null && (
          <div><dt>Agreed down payment</dt><dd>{money(agreed)}</dd></div>
        )}
        <div>
          <dt>
            Additional down payment
            {forPlan ? <small> (for the protection you have chosen)</small> : null}
          </dt>
          <dd>{money(additional)}</dd>
        </div>
        <div className="is-total"><dt>Total due at signing</dt><dd>{money(total)}</dd></div>
      </dl>
      <p className="fine">
        Your finance company approved a set amount. Your plan goes past it by{" "}
        {money(additional)}, so that amount is added to your money down.
      </p>
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
      <div><dt>Amount financed</dt><dd>{principal !== null ? money(principal) : "Not set"}</dd></div>
      <div><dt>Term</dt><dd>{term !== null ? `${term} months` : "Not set"}</dd></div>
      <div><dt>{rateLabel}</dt><dd>{rate !== null ? `${rate}%` : "Not set"}</dd></div>
    </dl>
  );
}
