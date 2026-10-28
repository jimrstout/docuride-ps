// components/ContractParties.tsx: who goes on the contracts.
//
// Three panels on Details: the buyer, the co-buyer and the lienholder, every
// field the contracts are sent with, in plain English. Each field is editable;
// a co-buyer or lienholder can be added when the CRM has none and removed with
// a confirmation. An edited field says who changed it, when, and what it was,
// and if the CRM has changed since, both are shown with a choice.
//
// Shown only to a signed-in operator (the page decides). Read-only while any
// contract on the deal is live, because the live contracts were registered
// with these details. The rules: supabase/functions/_shared/contract-parties.ts.

import PendingButton from "@/components/PendingButton";
import { Working } from "@/components/Working";
import { DX1_REMINDER } from "@/lib/contract-parties";
import type { ContractParties as Parties, Party, PartyField } from "@/lib/types";
import {
  keepStaffValue,
  removeParty,
  restoreParty,
  savePartyFields,
  useCrmValue,
} from "@/app/console-actions";

function stamp(iso: string | null): string {
  if (!iso) return "unknown time";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown time";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
  }).format(t).replace(",", "") + " UTC";
}

const lower = (p: Party["party"]) => p.toLowerCase();
const slug = (p: Party["party"]) => p.toLowerCase().replace(/[^a-z]+/g, "-");

function Input({ field, id }: { field: PartyField; id: string }) {
  const common = { id, name: field.key, defaultValue: field.value ?? "", autoComplete: "off" } as const;
  switch (field.input) {
    case "type":
      return (
        <select {...common} defaultValue={field.value ?? ""}>
          <option value="">Not set</option>
          <option value="Individual">Individual</option>
          <option value="Company">Company (a business)</option>
        </select>
      );
    case "state":
      return <input {...common} type="text" maxLength={2} autoCapitalize="characters" />;
    case "zip":
      return <input {...common} type="text" inputMode="numeric" maxLength={10} />;
    case "phone":
      return <input {...common} type="tel" />;
    case "email":
      return <input {...common} type="email" />;
    default:
      return <input {...common} type="text" />;
  }
}

function Row({ field, editable, idPrefix }: { field: PartyField; editable: boolean; idPrefix: string }) {
  const id = `${idPrefix}-${field.key}`;
  return (
    <div className={`vfield vparty-field${field.missing ? " is-missing" : ""}${field.edited ? " is-staff" : ""}`}>
      <label className="vfield-label" htmlFor={editable ? id : undefined}>{field.label}</label>
      <div className="vfield-control">
        {editable ? <Input field={field} id={id} /> : <p className="vfield-value">{field.value ?? <em>Not set</em>}</p>}
      </div>
      {field.missing ? <p className="vfield-note vparty-missing">{field.missing}</p> : null}
      {field.edited ? (
        <p className="vfield-note vparty-was">
          Entered by Staff: {field.edited_by ?? "unknown"}, {stamp(field.edited_at)}. Was {field.was ?? "not set"}.
        </p>
      ) : null}
      {field.crm_changed ? (
        <p className="vfield-note vparty-crm">CRM now says {field.crm_value ?? "nothing"}.</p>
      ) : null}
    </div>
  );
}

/** Where the CRM changed after a staff edit: keep the staff value, or use the CRM's. */
function CrmChoices({ party, sessionId, editable }: { party: Party; sessionId: string; editable: boolean }) {
  const changed = party.fields.filter((f) => f.crm_changed);
  if (changed.length === 0 || !editable) return null;
  return (
    <div className="vparty-choices">
      {changed.map((f) => (
        <div className="vparty-choice" key={f.key} data-working-panel="">
          <p>
            {party.party} {f.label.toLowerCase()}: staff value <strong>{f.value ?? "not set"}</strong>, CRM now
            says <strong>{f.crm_value ?? "nothing"}</strong>.
          </p>
          <form action={keepStaffValue}>
            <Working />
            <input type="hidden" name="session_id" value={sessionId} />
            <input type="hidden" name="key" value={f.key} />
            <PendingButton pending="Keeping...">Keep staff value</PendingButton>
          </form>
          <form action={useCrmValue}>
            <Working />
            <input type="hidden" name="session_id" value={sessionId} />
            <input type="hidden" name="key" value={f.key} />
            <PendingButton pending="Switching...">Use CRM value</PendingButton>
          </form>
        </div>
      ))}
    </div>
  );
}

function PartyPanel({ party, sessionId, editable }: { party: Party; sessionId: string; editable: boolean }) {
  const s = slug(party.party);
  const titleId = `vparty-${s}-title`;
  const removable = party.party !== "Buyer";

  // ── None on this deal ────────────────────────────────────────────────────
  if (!party.present) {
    const none = party.party === "Lienholder" ? "Cash deal, no lienholder." : "No co-buyer on this deal.";
    return (
      <section className="vgroup vparty" aria-labelledby={titleId}>
        <h2 className="vgroup-head" id={titleId}>{party.party}</h2>
        <p className="vparty-empty">{none}</p>
        {party.removed ? (
          <div className="vparty-body" data-working-panel="">
            <p className="vparty-note">
              Removed by Staff: {party.removed.by}, {stamp(party.removed.at)}. The CRM deal has one.
            </p>
            {editable ? (
              <form action={restoreParty}>
                <Working />
                <input type="hidden" name="session_id" value={sessionId} />
                <input type="hidden" name="party" value={party.party} />
                <PendingButton pending="Putting it back...">Put the CRM {lower(party.party)} back</PendingButton>
              </form>
            ) : null}
          </div>
        ) : editable ? (
          <details className="vparty-add">
            <summary>Add a {lower(party.party)}</summary>
            <form action={savePartyFields} className="vparty-form" data-working-panel="">
              <Working />
              <input type="hidden" name="session_id" value={sessionId} />
              <div className="vgroup-fields">
                {party.fields.map((f) => (
                  <Row key={f.key} field={f} editable idPrefix={`add-${s}`} />
                ))}
              </div>
              <div className="vparty-actions">
                <PendingButton pending="Saving...">Save {lower(party.party)}</PendingButton>
              </div>
            </form>
          </details>
        ) : null}
      </section>
    );
  }

  // ── One on this deal ─────────────────────────────────────────────────────
  return (
    <section className="vgroup vparty" aria-labelledby={titleId}>
      <h2 className="vgroup-head" id={titleId}>{party.party}</h2>
      {party.business ? (
        <p className="vparty-business">
          Business {lower(party.party)}: <strong>{party.heading ?? "name not set"}</strong>
        </p>
      ) : party.heading ? (
        <p className="vparty-heading">{party.heading}</p>
      ) : null}
      <form action={savePartyFields} className="vparty-form" data-working-panel="">
        <Working />
        <input type="hidden" name="session_id" value={sessionId} />
        <div className="vgroup-fields">
          {party.fields.map((f) => (
            <Row key={f.key} field={f} editable={editable} idPrefix={`p-${s}`} />
          ))}
        </div>
        {editable ? (
          <div className="vparty-actions">
            <PendingButton pending="Saving...">Save {lower(party.party)}</PendingButton>
          </div>
        ) : null}
      </form>
      <CrmChoices party={party} sessionId={sessionId} editable={editable} />
      {editable && removable ? (
        <details className="vparty-remove">
          <summary>Remove the {lower(party.party)}</summary>
          <form action={removeParty} data-working-panel="">
            <Working />
            <input type="hidden" name="session_id" value={sessionId} />
            <input type="hidden" name="party" value={party.party} />
            <p className="vparty-note">
              This takes the {lower(party.party)} off the service contracts on this deal. {DX1_REMINDER}
            </p>
            <label className="vparty-confirm">
              <input type="checkbox" name="confirm" value="1" required /> Yes, remove the {lower(party.party)}
            </label>
            <PendingButton pending="Removing...">Remove {lower(party.party)}</PendingButton>
          </form>
        </details>
      ) : null}
    </section>
  );
}

export default function ContractParties({
  parties,
  sessionId,
}: {
  parties: Parties;
  sessionId: string;
}) {
  const editable = !parties.locked;
  return (
    <section className="vparties" aria-labelledby="vparties-title">
      <h2 id="vparties-title" className="vparties-title">Who goes on the contracts</h2>
      {parties.locked && parties.lock_reason ? (
        <p className="console-flash vparties-lock" role="status">{parties.lock_reason}</p>
      ) : (
        <p className="vparties-intro">
          What the service contracts are sent with. Corrections here do not change the CRM or DX1.
        </p>
      )}
      <div className="vparties-grid">
        {parties.parties.map((p) => (
          <PartyPanel key={p.party} party={p} sessionId={sessionId} editable={editable} />
        ))}
      </div>
    </section>
  );
}
