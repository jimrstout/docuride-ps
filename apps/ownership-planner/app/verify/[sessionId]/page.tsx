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
import { cookies } from "next/headers";
import { currentOperator } from "@/lib/admin-session";
import { currentChecker } from "@/lib/checker";
import { edge, EdgeError, isSessionId } from "@/lib/edge";
import type { FieldGroup, VerifyField, VerifySheet } from "@/lib/types";
import { VerifySidebarFields } from "@/components/VerifySidebarFields";
import {
  VERIFY_FLASH_COOKIE,
  decodeVerifyFlash,
  flashMessage,
} from "@/lib/verify-flash";
import {
  clearSubmitUnknown,
  decodeVin,
  discardEdits,
  refreshFromCrm,
  saveVerifyFields,
  setCheckerName,
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
  vehicle_type_code: "UTV, ATV, MCYC, BIKE, PWAC, BOAT or SNOW.",
  deal_type: "Cash, Finance or Lease.",
  condition: "New or Used.",
  sale_date: "YYYY-MM-DD.",
  in_service_date: "YYYY-MM-DD.",
  sale_price: "A plain number. No currency symbol needed.",
  amount_financed: "A plain number.",
  finance_term: "Whole months.",
  apr: "A percentage, as a number.",
};

/** The three that take a word rather than a number, so the keypad stays away. */
const TEXT_FIELDS = new Set([
  "fuel.type", "vehicle_type_code", "deal_type", "condition",
  "vin", "unit_make", "unit_model", "buyer_city", "buyer_state",
  "sale_date", "in_service_date",
]);

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

/**
 * One rating input, as one row: label, value, source.
 *
 * ── Why a row and not a card ────────────────────────────────────────────
 * The first version gave every field a card with its explanation printed
 * underneath. Twenty-three cards of that height ran the sheet to three screens,
 * and most of the extra height was the same sentence repeated ("From the CRM
 * deal. Edit it here to correct the rate."). The job here is to scan a column
 * for Missing, so the whole sheet now fits on one desktop screen.
 *
 * Nothing was thrown away. The note and the typing help sit in the row's
 * tooltip, and come out into the open only when they are needed: on a field
 * that is missing or that could not be read.
 */
function Field({ field }: { field: VerifyField }) {
  const help = EDITABLE_HELP[field.key];
  const edited = field.original_source !== null;
  const id = `vf-${field.key}`;

  const state =
    field.invalid ? "is-invalid"
    : field.missing ? "is-missing"
    : field.differs_from_crm ? "is-differs"
    : edited ? "is-edited"
    : "";

  // Shown in full only when the person has something to do about this field.
  const needsHelp = field.missing || field.invalid;
  const tip = [field.label, field.note, help].filter(Boolean).join(" ");

  // The long form of what an edit replaced, for the tooltip. The short form is
  // on the page.
  const wasDetail = edited
    ? [
        field.invalid
          ? "This edit could not be read, so it is not in force."
          : field.differs_from_crm
            ? "The CRM deal still says the old value."
            : field.in_crm
              ? "The CRM deal now matches."
              : "The CRM does not carry this field.",
        "Clear the box to go back to the original.",
      ].join(" ")
    : "";

  return (
    <div id={`field-${field.key}`} className={`vfield ${state}`} title={tip}>
      <label className="vfield-label" htmlFor={field.editable ? id : undefined}>
        {field.label}
        {field.required ? (
          <abbr className="vfield-req" title="TecAssured asks for this">*</abbr>
        ) : null}
      </label>

      <div className="vfield-control">
        {field.editable ? (
          <input
            id={id}
            type="text"
            name={field.key}
            defaultValue={field.value ?? ""}
            autoComplete="off"
            inputMode={TEXT_FIELDS.has(field.key) ? "text" : "numeric"}
            placeholder={field.missing ? "Needed to rate" : ""}
            aria-invalid={field.invalid ? true : undefined}
          />
        ) : (
          <p className="vfield-value">{field.value ?? <em>Not set</em>}</p>
        )}
      </div>

      <Source source={field.source} />

      {needsHelp && (help || field.note) ? (
        <p className="vfield-note">{help ?? field.note}</p>
      ) : null}

      {/* ── What this replaced ──────────────────────────────────────────
          Shown for every edit, not only the ones that disagree with CRM. The
          question a person asks looking at a corrected price is "what was it",
          and they should not have to open the CRM to find out. One line; the
          rest is in the tooltip. */}
      {edited ? (
        <p className="vfield-was" title={wasDetail}>
          Was <span className="vfield-was-value">{field.original ?? "not set"}</span>
          {" "}({field.original_source}), changed by {field.edited_by ?? "unknown"},{" "}
          {stamp(field.edited_at)}.
          {field.invalid
            ? " Not in force."
            : field.differs_from_crm
              ? " The CRM deal still says the old value."
              : ""}
        </p>
      ) : null}
    </div>
  );
}

export default async function VerifyPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  // No sign-in. The CRM button opens this screen directly and what protects it
  // is holding the session link, the same as the presentation.
  //
  // `checker` is a name for the record, not a permission: see lib/checker.ts.
  // `operator` is still read, but only to decide whether to offer Void, which
  // reaches TecAssured and undoes real paperwork.
  const checker = await currentChecker();
  const operator = await currentOperator();

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

  // The one-shot message from whatever action just ran. It arrives in a
  // short-lived cookie, not in the URL, so a provider refusal or a contract
  // number never ends up in the address bar in front of a customer or in a
  // pasted link. See lib/verify-flash.ts.
  const flash = flashMessage(decodeVerifyFlash((await cookies()).get(VERIFY_FLASH_COOKIE)?.value));

  const verified = sheet.verification.state === "Verified";
  const byGroup = (g: FieldGroup) => sheet.fields.filter((f) => f.group === g);
  const attention = sheet.fields.filter((f) => f.missing || f.invalid);

  return (
    <main className="console console--verify">
      <header className="console-head">
        <div>
          <p className="console-eyebrow">
            DocuRide PS
            <Link className="console-back" href="/" prefetch={false}>
              Session browser
            </Link>
          </p>
          <h1 className="console-title">
            Verify deal {sheet.session.deal_number ?? "(no number)"}
          </h1>
        </div>
        <div className="console-who">
          {/* Who is checking this deal. One box, once per device, remembered in a
              cookie. It is a name on a record and not a sign-in: the endpoint
              refuses a verification with nobody's name on it, so the name has to
              come from somewhere, and with no accounts it comes from here. */}
          <form action={setCheckerName} className="vwho">
            <label htmlFor="checker_name">Checked by</label>
            <input
              id="checker_name"
              type="text"
              name="checker_name"
              defaultValue={checker}
              placeholder="Your name"
              autoComplete="name"
              aria-label="Your name, recorded on the verification"
            />
            <button type="submit" className="btn btn--quiet">
              {checker ? "Change" : "Save"}
            </button>
          </form>
          <form action={refreshFromCrm}>
            <input type="hidden" name="session_id" value={sheet.session.id} />
            <button type="submit" className="btn btn--quiet">
              Refresh from CRM
            </button>
          </form>
        </div>
      </header>

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
          {operator ? (
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
          ) : (
            <p className="vfield-note">
              Clearing this needs a sign-in, because it is a statement that
              somebody looked at TecAssured.{" "}
              <Link href="/" prefetch={false}>Sign in</Link> to clear it.
            </p>
          )}
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
                        {/* Void is the one thing on this screen that still needs
                            a sign-in. It calls TecAssured and cancels real
                            paperwork, which is not something a session link
                            should authorise. The contract is still listed either
                            way, because knowing it exists is what stops somebody
                            trying to submit it again. */}
                        {!c.contract_number ? (
                          <small>No number to void by. Ask TecAssured.</small>
                        ) : operator ? (
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
                          <Link className="btn btn--quiet" href="/" prefetch={false}>
                            Sign in to void
                          </Link>
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

      {/* Put work that blocks verification ahead of the reference sheet. Each
          field appears in exactly one place so edits cannot conflict. */}
      <div className="vworkspace">
      {attention.length > 0 ? (
        <aside className="vattention" aria-labelledby="vattention-title">
          <p className="vattention-kicker">To complete</p>
          <h2 id="vattention-title">{attention.length} required {attention.length === 1 ? "field" : "fields"}</h2>
          <VerifySidebarFields fields={attention.map((f) => ({
            key: f.key, label: f.label, group: f.group, value: f.value,
          }))} />
          <div className="vattention-actions">
            {attention.some((f) => f.key === "engine.ccs" || f.key === "fuel.type") ? (
              <button type="submit" form="vin-decode" className="btn btn--quiet" title="Decoding reloads this page. Save any other edits first.">Decode VIN</button>
            ) : null}
            <button type="submit" form="vsheet" className="btn btn--go">Save changes</button>
          </div>
        </aside>
      ) : null}

      {/* Each field keeps its permanent location in the review sheet. */}
      <form action={saveVerifyFields} id="vsheet" className="vsheet">
        <input type="hidden" name="session_id" value={sheet.session.id} />

        {GROUPS.map(({ group, blurb }) => {
          const fields = byGroup(group);
          if (fields.length === 0) return null;
          return (
            <section className={`vgroup vgroup--${group.toLowerCase()}`} key={group}>
              <h2 className="vgroup-head" title={blurb}>{group === "Money" ? "Financial" : group}</h2>
              <div className="vgroup-fields">
                {fields.map((f) => (
                  <Field key={f.key} field={f} />
                ))}
              </div>
            </section>
          );
        })}
      </form>

      {/* ── The tools ──────────────────────────────────────────────────── */}
      {/* One row. Save belongs to the sheet form through its form attribute, so
          it can sit here without Decode and Discard being nested inside that
          form. They stay separate forms on purpose: a VIN decode is not a save
          and must not post half-typed values, and Discard throws work away. */}
      <div className="vtools">
        <button type="submit" form="vsheet" className="btn btn--quiet">
          Save changes
        </button>

        <form
          id="vin-decode"
          action={decodeVin}
          title="Asks TecAssured what this VIN is. Fills engine size and fuel type. It does not return warranty information, so that one is always typed."
        >
          <input type="hidden" name="session_id" value={sheet.session.id} />
          <button type="submit" className="btn btn--quiet">
            Decode the VIN
          </button>
        </form>

        {sheet.edited.some((f) => f.in_crm) ? (
          <form
            action={discardEdits}
            title="Puts the CRM deal back in charge of every field it carries. Engine size, factory warranty and fuel type are kept, since the CRM does not carry them and there would be nothing to reload them from."
          >
            <input type="hidden" name="session_id" value={sheet.session.id} />
            <button type="submit" className="btn btn--quiet">
              Discard my edits and reload from CRM
            </button>
          </form>
        ) : null}

        <p className="vfield-note">
          * TecAssured asks for this. Hover a field to see where its value comes
          from. Clearing a box puts the original value back. Nothing is written
          back to the CRM.
          {sheet.vin_decode_at ? ` VIN last decoded ${stamp(sheet.vin_decode_at)}.` : ""}
        </p>
      </div>
      </div>

      {/* ── The gate ───────────────────────────────────────────────────── */}
      <form action={verifyAndRate} className="vgate">
        <input type="hidden" name="session_id" value={sheet.session.id} />

        {/* ── Values that no longer match the deal ──────────────────────────
            Above the button, on purpose, and it does not disable it: the person
            at the desk can see the machine and the paperwork, so their figure is
            the one to rate on. It stays here until the CRM deal is brought into
            line and the sheet is refreshed, which is the only thing that clears
            it. */}
        {sheet.crm_warning ? (
          <div className="vgate-warn" role="alert">
            <p className="vgate-warn-say">{sheet.crm_warning}</p>
            <table className="vgate-warn-table">
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">CRM deal</th>
                  <th scope="col">This session</th>
                  <th scope="col">Changed by</th>
                </tr>
              </thead>
              <tbody>
                {sheet.crm_mismatches.map((m) => (
                  <tr key={m.key}>
                    <td data-label="Field">{m.label}</td>
                    <td data-label="CRM deal">{m.crm_value ?? "Not set"}</td>
                    <td data-label="This session" className="cell-strong">
                      {m.edited_value ?? "Not set"}
                    </td>
                    <td data-label="Changed by">
                      {m.edited_by}
                      <small>{stamp(m.edited_at)}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="vfield-note">
              You can still verify and rate. The rate will use this session's
              values. Nothing is sent back to the CRM.
            </p>
          </div>
        ) : null}

        {/* Previously verified, and this is a fresh launch from CRM. The values
            below are the ones that were approved, and saying so is the
            difference between "check this again" and "somebody already did
            this". */}
        {verified ? (
          <p className="vgate-was">
            Verified by <b>{sheet.verification.verified_by ?? "unknown"}</b> on{" "}
            {stamp(sheet.verification.verified_at)}. The values below are what
            was verified.
          </p>
        ) : null}

        {sheet.ready ? (
          <p className="vgate-say">
            Every field TecAssured asks for has a value. Confirming records your
            name, the time, and each value with its source, asks for the rate,
            and opens the presentation.
          </p>
        ) : (
          <p className="vgate-say vgate-say--blocked">
            {sheet.invalid.length > 0 ? (
              <>
                These changes could not be read, so they are not in force:{" "}
                <b>{sheet.invalid.map((f) => f.label).join(", ")}</b>. Correct them
                above, or clear the box to go back to the original.
              </>
            ) : sheet.missing.length > 0 ? (
              <>
                Still needed before this can be verified:{" "}
                <b>{sheet.missing.map((f) => f.label).join(", ")}</b>.
              </>
            ) : (
              <>This deal cannot be verified yet.</>
            )}
          </p>
        )}

        {/* The name travels with the button, so typing it and confirming in one
            motion works. The action writes it back to the cookie. */}
        <input type="hidden" name="checker_name" value={checker} />

        <button
          type="submit"
          className="btn btn--go"
          disabled={!sheet.ready || checker === ""}
        >
          Confirm and Continue
        </button>

        <p className="vfield-note">
          {checker === ""
            ? "Put your name in the Checked by box at the top before confirming."
            : `Confirming as ${checker}. This opens the presentation at step 1.`}
        </p>
      </form>
    </main>
  );
}
