// app/verify/[sessionId]/page.tsx — the staff Verify step.
//
// Everything that goes into a TecAssured rate request, on one page, with where
// each value came from beside it. Nothing here is ever shown to a customer, and
// the page deliberately carries no link to or from the planner.
//
// ── Why the provenance column is the point ──────────────────────────────
// A rate is a price somebody is shown. Before this screen existed the planner
// assembled one unattended from a deal nobody had looked at, and two of the
// seventeen fields TecAssured wants for a UTV have no source in the CRM at all.
// So the question this page answers is not "are the fields full" but "where did
// each of these come from, and is that good enough to put a price on".
//
// ── The editing rule, and why it is strict ──────────────────────────────
// A field the CRM owns is read-only here. The deal is the record, the contract
// is written from the deal, and a screen that let someone type a different sale
// price would put the planner and the paperwork out of step with nothing to say
// which was right. Corrections go to CRM and come back through Refresh.
//
// Only two fields are typed here, and both because nothing else in the system
// knows them: engine size (which the VIN decode usually answers) and remaining
// factory warranty months (which nothing answers).

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentOperator } from "@/lib/admin-session";
import { edge, EdgeError, isSessionId } from "@/lib/edge";
import type { FieldGroup, VerifyField, VerifySheet } from "@/lib/types";
import {
  clearSubmitUnknown,
  decodeVin,
  refreshFromCrm,
  saveVerifyFields,
  verifyAndRate,
  voidContract,
} from "@/app/console-actions";

export const dynamic = "force-dynamic";

const GROUPS: { group: FieldGroup; blurb: string }[] = [
  { group: "Deal", blurb: "Which deal this is, and how it is being paid for." },
  { group: "Vehicle", blurb: "What the machine is. This is where the gaps usually are." },
  { group: "Money", blurb: "What it costs and how it is financed." },
  { group: "Customer", blurb: "Where they live. Nothing else is needed to rate." },
];

/** Which fields a person may type. The Edge Function refuses the rest by name. */
const EDITABLE_HELP: Record<string, string> = {
  "engine.ccs": "Engine displacement in cc.",
  warranty: "Whole months of factory coverage left on the day of sale.",
  "fuel.type": "G, E or D.",
};

function stamp(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
  }).format(t).replace(",", "") + " UTC";
}

/** The provenance chip. Missing is the only one that shouts. */
function Source({ source }: { source: VerifyField["source"] }) {
  const tone =
    source === "Missing" ? "tag--expired"
    : source === "CRM" ? "tag--live"
    : "tag--quiet";
  return <span className={`tag ${tone}`}>{source}</span>;
}

function Field({ field }: { field: VerifyField }) {
  const help = EDITABLE_HELP[field.key];

  return (
    <div className={`vfield ${field.missing ? "is-missing" : ""}`}>
      <div className="vfield-head">
        <span className="vfield-label">
          {field.label}
          {field.required ? (
            <abbr className="vfield-req" title="TecAssured asks for this">
              required
            </abbr>
          ) : null}
        </span>
        <Source source={field.source} />
      </div>

      {field.editable ? (
        <>
          <input
            type="text"
            name={field.key}
            defaultValue={field.value ?? ""}
            autoComplete="off"
            inputMode={field.key === "fuel.type" ? "text" : "numeric"}
            placeholder={field.missing ? "Needed to rate" : ""}
            aria-label={field.label}
          />
          {help ? <p className="vfield-note">{help}</p> : null}
        </>
      ) : (
        <>
          <p className="vfield-value">
            {field.value ?? <em>Not set</em>}
          </p>
          {field.note ? <p className="vfield-note">{field.note}</p> : null}
        </>
      )}
    </div>
  );
}

export default async function VerifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const operator = await currentOperator();
  if (!operator) redirect("/");

  const { sessionId } = await params;
  if (!isSessionId(sessionId)) notFound();

  let sheet: VerifySheet;
  try {
    sheet = await edge.verifySheet<VerifySheet>(sessionId);
  } catch (err) {
    if (err instanceof EdgeError && err.status === 404) notFound();
    console.error("verify sheet failed:", err);
    return (
      <main className="console">
        <p className="console-empty">
          This session could not be loaded right now. Try again shortly.
        </p>
      </main>
    );
  }

  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : null);

  const refused = one("refused");
  const flash =
    refused ? { tone: "bad", text: refused }
    : one("verified") ? {
        tone: "ok",
        text:
          one("rated") === "failed"
            ? "Verified. The rate did not come back; see Rating below and try again."
            : "Verified, and the rate has been requested.",
      }
    : one("saved") ? { tone: "ok", text: "Saved." }
    : one("decoded") ? { tone: "ok", text: "Decoded from the VIN." }
    : one("refreshed") ? { tone: "ok", text: "Re-pulled from CRM." }
    : one("voided") ? {
        tone: "ok",
        text:
          `Contract ${one("voided")} is voided. That product can be submitted ` +
          `again on this deal.`,
      }
    : one("cleared") ? {
        tone: "ok",
        text: "Recorded as checked. This session can submit again.",
      }
    : null;

  const verified = sheet.verification.state === "Verified";
  const byGroup = (g: FieldGroup) => sheet.fields.filter((f) => f.group === g);

  return (
    <main className="console">
      <header className="console-head">
        <div>
          <p className="console-eyebrow">DocuRide PS</p>
          <h1 className="console-title">
            Verify deal {sheet.session.deal_number ?? "(no number)"}
          </h1>
        </div>
        <form action={refreshFromCrm} className="console-who">
          <span>{operator.email}</span>
          <input type="hidden" name="session_id" value={sheet.session.id} />
          <button type="submit" className="btn btn--quiet">
            Refresh from CRM
          </button>
        </form>
      </header>

      <nav className="console-tabs">
        <Link className="btn btn--quiet" href="/" prefetch={false}>
          Session browser
        </Link>
        <span className="console-tab-here">
          Verify {sheet.session.deal_number ?? ""}
        </span>
      </nav>

      {flash ? (
        <p
          className={flash.tone === "ok" ? "console-flash" : "console-flash console-flash--bad"}
          role="status"
        >
          {flash.text}
        </p>
      ) : null}

      {/* ── Where this session stands ──────────────────────────────────── */}
      <dl className="vstate">
        <div>
          <dt>Vehicle</dt>
          <dd>
            {sheet.session.vehicle || "Not set"}
            {sheet.session.stock_number ? <small>Stock {sheet.session.stock_number}</small> : null}
          </dd>
        </div>
        <div>
          <dt>Deal type</dt>
          <dd>{sheet.session.deal_type ?? "Not set"}</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>
            <span className={`tag ${verified ? "tag--live" : "tag--expired"}`}>
              {sheet.verification.state}
            </span>
            {verified ? (
              <small>
                {sheet.verification.verified_by}, {stamp(sheet.verification.verified_at)}
              </small>
            ) : (
              <small>The customer sees a neutral message until this is done.</small>
            )}
          </dd>
        </div>
        <div>
          <dt>Rating</dt>
          <dd>
            <span className="tag tag--quiet">
              {sheet.rating.out_of_date ? "Out of date" : sheet.rating.state}
            </span>
            <small>
              {sheet.rating.state === "Rated"
                ? `${sheet.rating.product_count} products, ${stamp(sheet.rating.rated_at)}`
                : sheet.rating.detail ?? "No rate yet."}
            </small>
          </dd>
        </div>
      </dl>

      {sheet.session.is_test ? (
        <p className="note note--flag">
          This is a test session. It has no CRM deal behind it, so Refresh has
          nothing to pull.
        </p>
      ) : null}

      {sheet.not_ready_reason ? (
        <p className="console-flash console-flash--bad" role="alert">
          {sheet.not_ready_reason}
        </p>
      ) : null}

      {sheet.unmapped_properties.length > 0 ? (
        <p className="console-flash console-flash--bad" role="alert">
          TecAssured is asking for {sheet.unmapped_properties.join(", ")}, which
          this screen has no field for. Nothing can be verified until it does.
        </p>
      ) : null}

      {/* ── Another open deal on this machine ──────────────────────────── */}
      {/* A warning, not a block. Two deals on one VIN is sometimes a mistake
          and sometimes a deal being re-written after the first fell through,
          and nothing here can tell the difference. Staff can, once they can see
          the other deal, which is what the link is for. */}
      {sheet.duplicate_vin ? (
        <p className="console-flash console-flash--bad" role="alert">
          {sheet.duplicate_vin.message}{" "}
          {sheet.duplicate_vin.sessions.map((other, i) => (
            <span key={other.id}>
              {i > 0 ? " " : ""}
              <Link href={`/verify/${other.id}`} prefetch={false}>
                Open deal {other.deal_number ?? "(no number)"}
              </Link>
              {" "}({other.status})
            </span>
          ))}
        </p>
      ) : null}

      {/* ── A submit whose outcome nobody knows ─────────────────────────── */}
      {/* Nothing clears this on a timer, because a timer would be guessing that
          no contract was created, and that guess is how one deal ends up with
          two of the same contract. It takes a person saying they looked. */}
      {sheet.submit_state === "Submit Status Unknown" ? (
        <section className="note note--panel">
          <h2>Submit Status Unknown</h2>
          <p>
            A submit reached TecAssured and never came back, so we do not know
            whether it created contracts. Nothing has been retried and nothing
            will be. Check the deal in TecAssured. If contracts were created,
            void the ones that should not stand, then clear this.
          </p>
          {sheet.submit_detail ? <p><small>{sheet.submit_detail}</small></p> : null}
          <form action={clearSubmitUnknown}>
            <input type="hidden" name="session_id" value={sheet.session.id} />
            <input
              type="text"
              name="note"
              placeholder="What you found in TecAssured (optional)"
            />
            <button type="submit" className="btn btn--quiet">
              I have checked TecAssured
            </button>
          </form>
        </section>
      ) : null}

      {/* ── Paperwork that already stands ───────────────────────────────── */}
      {/* Here because this is where staff land when CRM sends a deal through a
          second time. A product with a live contract cannot be submitted again,
          and voiding is the only way to change that, so the two live together. */}
      {sheet.contracts.length > 0 ? (
        <>
          <p className="console-note">
            Contracts already submitted on this deal:{" "}
            {sheet.contracts
              .map((c) => c.contract_number ?? "number not returned")
              .join(", ")}
            . A product with a live contract cannot be submitted again. Void it
            first if the customer has changed their mind.
          </p>
          <div className="console-scroll">
            <table className="console-table">
              <thead>
                <tr>
                  <th scope="col">Contract</th>
                  <th scope="col">Product</th>
                  <th scope="col">Status</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {sheet.contracts.map((c) => (
                  <tr key={`${c.provider_product_id}-${c.contract_number}`}>
                    <td className="cell-deal">{c.contract_number ?? "Not returned"}</td>
                    <td className="cell-vehicle">{c.product_name ?? c.provider_product_id}</td>
                    <td>
                      <span className="tag tag--quiet">{c.status}</span>
                    </td>
                    <td className="cell-do">
                      <div className="cell-do-inner">
                        {c.contract_number ? (
                          <form action={voidContract}>
                            <input type="hidden" name="session_id" value={sheet.session.id} />
                            <input
                              type="hidden"
                              name="contract_number"
                              value={c.contract_number}
                            />
                            <button type="submit" className="btn btn--quiet">
                              Void
                            </button>
                          </form>
                        ) : (
                          <small>No number to void by. Ask TecAssured.</small>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {sheet.changed_inputs && sheet.changed_inputs.length > 0 ? (
        <p className="console-flash console-flash--bad" role="alert">
          CRM changed {sheet.changed_inputs.length}{" "}
          {sheet.changed_inputs.length === 1 ? "rating input" : "rating inputs"}, so
          this deal needs verifying again and the old rates are out of date.
        </p>
      ) : null}

      {/* ── The sheet ──────────────────────────────────────────────────── */}
      <form action={saveVerifyFields} className="vsheet">
        <input type="hidden" name="session_id" value={sheet.session.id} />

        {GROUPS.map(({ group, blurb }) => {
          const fields = byGroup(group);
          if (fields.length === 0) return null;
          return (
            <section className="vgroup" key={group}>
              <div className="vgroup-head">
                <h2>{group}</h2>
                <p>{blurb}</p>
              </div>
              <div className="vgroup-fields">
                {fields.map((f) => (
                  <Field key={f.key} field={f} />
                ))}
              </div>
            </section>
          );
        })}

        <div className="vactions">
          <button type="submit" className="btn btn--quiet">
            Save entered fields
          </button>
        </div>
      </form>

      {/* Its own form: a VIN decode is not a save, and pressing it should not
          submit half-typed values in the sheet above. */}
      <form action={decodeVin} className="vactions vactions--aside">
        <input type="hidden" name="session_id" value={sheet.session.id} />
        <button type="submit" className="btn btn--quiet">
          Decode the VIN
        </button>
        <p className="vfield-note">
          Asks TecAssured what this VIN is. Fills engine size and fuel type. It
          does not return warranty information, so that one is always typed.
          {sheet.vin_decode_at ? ` Last decoded ${stamp(sheet.vin_decode_at)}.` : ""}
        </p>
      </form>

      {/* ── The gate ───────────────────────────────────────────────────── */}
      <form action={verifyAndRate} className="vgate">
        <input type="hidden" name="session_id" value={sheet.session.id} />

        {sheet.ready ? (
          <p className="vgate-say">
            Every field TecAssured asks for has a value. Verifying records your
            name, the time, and each value with its source, then asks for the
            rate.
          </p>
        ) : (
          <p className="vgate-say vgate-say--blocked">
            {sheet.missing.length > 0 ? (
              <>
                Still needed before this can be verified:{" "}
                <b>{sheet.missing.map((f) => f.label).join(", ")}</b>.
              </>
            ) : (
              <>This deal cannot be verified yet.</>
            )}
          </p>
        )}

        <button type="submit" className="btn btn--go" disabled={!sheet.ready}>
          {verified ? "Verify again and re-rate" : "Verify and rate"}
        </button>
      </form>
    </main>
  );
}
