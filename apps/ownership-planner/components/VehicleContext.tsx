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

export default function VehicleContext({
  session,
  profile,
  photo,
  vehicleName,
  children,
}: {
  session: PlannerSession;
  profile: VehicleProfile;
  /** A real photograph of this unit, or null. Never a substitute. */
  photo: string | null;
  vehicleName: string;
  /** Contextual navigation for the current step, when there is any. */
  children?: React.ReactNode;
}) {
  const v = session.vehicle;
  const f = session.financials;
  const facts = [
    v.condition,
    v.stock_number ? `Stock ${v.stock_number}` : null,
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

      {(f.finance_type || f.term_months !== null || f.rate_used !== null) && (
        <dl className="rail-deal">
          {f.finance_type && (<><dt>Type</dt><dd>{f.finance_type}</dd></>)}
          {f.term_months !== null && (<><dt>Term</dt><dd>{f.term_months} months</dd></>)}
          {f.rate_used !== null && (<><dt>{f.rate_label ?? "Rate"}</dt><dd>{f.rate_used}%</dd></>)}
          {f.lienholder_name && (<><dt>Lender</dt><dd>{f.lienholder_name}</dd></>)}
        </dl>
      )}

      <p className="rail-note">
        These terms come from your finalized deal. If anything needs to change,
        your dealership updates the deal and this plan is refreshed.
      </p>

      {children}

      {/* Atmospheric, and of the right kind of country for what they bought.
          Never captioned as their machine. The quote stands on its own until
          real photography exists -- see PHOTOGRAPHY_READY in lib/profiles. */}
      <figure className="rail-mood">
        {PHOTOGRAPHY_READY && <img src={profile.railImage} alt={profile.railAlt} />}
        <figcaption>{profile.tagline}</figcaption>
      </figure>
    </aside>
  );
}
