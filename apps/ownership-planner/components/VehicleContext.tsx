// The persistent left rail: what the customer bought, and the terms that are
// already settled.
//
// Two rules hold this together.
//
// It never invents a vehicle photograph. A stock image of a different trim or
// colour presented as "your vehicle" is a lie the customer can see, and worse
// than no photograph -- so a real image from the DX1 lookup is used when one
// exists, and a typographic identity plate when one does not. The atmospheric
// photograph below is a separate thing and is never captioned as their machine.
//
// It never fabricates a figure. A deal with no lienholder has no term, rate or
// lender, and printing those headings with dashes under them implies a loan
// that does not exist -- so each line appears only when the deal carries it.

import type { PlannerSession } from "@/lib/types";
import { PHOTOGRAPHY_READY, type VehicleProfile } from "@/lib/profiles";
import { money } from "@/lib/money";

export default function VehicleContext({
  session,
  profile,
  photo,
  vehicleName,
  agreedDown = null,
  additionalDown = 0,
  children,
}: {
  session: PlannerSession;
  profile: VehicleProfile;
  /** A real photograph of this unit, or null. Never a substitute. */
  photo: string | null;
  vehicleName: string;
  /** The deal's agreed down payment, or null on a cash deal or when there is none. */
  agreedDown?: number | null;
  /** What the plan adds to the money down because it passes the finance
   *  company's maximum. Zero when it does not. The same figure the payment
   *  step shows. */
  additionalDown?: number;
  /** Contextual navigation for the current step, when there is any. */
  children?: React.ReactNode;
}) {
  const v = session.vehicle;
  const f = session.financials;
  // Condition, stock number, then the deal number.
  //
  // The deal number is here for STAFF, on a customer-facing panel, and that is
  // deliberate: duplicate deals on the same unit do happen, and the person
  // sitting beside the customer needs to confirm which one this planner is
  // attached to without leaving the screen. It reads as an ordinary reference
  // number to the customer, which is what it is.
  //
  // It is the same value the CRM calls the MUI number, carried on the session
  // since fni-session-start; nothing new is read from the deal record for it.
  const facts = [
    v.condition,
    v.stock_number ? `Stock ${v.stock_number}` : null,
    session.deal_number ? `Deal #${session.deal_number}` : null,
  ].filter(Boolean);

  return (
    <aside className="rail" aria-label="Your vehicle and deal">
      <p className="eyebrow">Your ride</p>

      {photo ? (
        <img className="rail-photo" src={photo} alt={vehicleName} />
      ) : (
        <div className="plate">
          {v.year !== null && <span className="plate-year">{v.year}</span>}
          <span className="plate-name">
            {v.make}
            {v.model ? <><br />{v.model}</> : null}
          </span>
          {v.vin && <span className="plate-vin">VIN {v.vin}</span>}
        </div>
      )}

      <h2 className="rail-name">{vehicleName || "Your vehicle"}</h2>
      {facts.length > 0 && <p className="rail-facts">{facts.join(" · ")}</p>}

      {(f.finance_type || f.term_months !== null || f.rate_used !== null ||
        agreedDown !== null || additionalDown > 0) && (
        <dl className="rail-deal">
          {f.finance_type && (<><dt>Type</dt><dd>{f.finance_type}</dd></>)}
          {f.term_months !== null && (<><dt>Term</dt><dd>{f.term_months} months</dd></>)}
          {f.rate_used !== null && (<><dt>{f.rate_label ?? "Rate"}</dt><dd>{f.rate_used}%</dd></>)}
          {f.lienholder_name && (<><dt>Lender</dt><dd>{f.lienholder_name}</dd></>)}
          {agreedDown !== null && (<><dt>Agreed down payment</dt><dd>{money(agreedDown)}</dd></>)}
          {additionalDown > 0 && (<><dt>Additional down payment</dt><dd>{money(additionalDown)}</dd></>)}
        </dl>
      )}

      <p className="rail-note">
        From your finalized deal. Your dealership updates the deal if anything
        needs to change.
      </p>

      {children}

      {/* Atmospheric, and of the right kind of country for what they bought.
          Never captioned as their machine. The quote stands on its own until
          real photography exists -- see PHOTOGRAPHY_READY in lib/profiles.
          It is the first thing the stylesheet drops when height is short. */}
      <figure className="rail-mood">
        {PHOTOGRAPHY_READY && <img src={profile.railImage} alt={profile.railAlt} />}
        <figcaption>{profile.tagline}</figcaption>
      </figure>
    </aside>
  );
}
