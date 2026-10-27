// app/verify/[sessionId]/page.tsx: the staff Verify step.
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
import type { Metadata } from "next";
import HomeLink from "@/components/HomeLink";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { currentOperator } from "@/lib/admin-session";
import { currentChecker } from "@/lib/checker";
import { edge, EdgeError, isSessionId } from "@/lib/edge";
import type { FieldGroup, VerifyField, VerifySheet } from "@/lib/types";
import { VerifySidebarFields } from "@/components/VerifySidebarFields";
import {
  AUTO_DECODE_TIMEOUT_MS,
  decodeDidNotAnswer,
  shouldAutoDecode,
} from "@/lib/auto-decode";
import { FUEL_TYPE_CHOICES } from "@/lib/verify-fields";
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
  setPlannedSaleDate,
  clearPlannedSaleDate,
  saveVerifyFields,
  setCheckerName,
  verifyAndRate,
  voidContract,
  voidOemContract,
  submitContracts,
  getContractDocument,
  moveDocumentsToDealJacket,
} from "@/app/console-actions";
import PendingButton from "@/components/PendingButton";
import LongText from "@/components/LongText";
import RatingErrorText from "@/components/RatingErrorText";
import { dayLabel, storeTime } from "@/lib/store-time";
import {
  hasMoreDetail,
  ratingErrorHeadline,
  ratingErrorSummary,
  ratingFailures,
  type RatingFailureText,
} from "@/lib/rating-error";
import { Working, WorkingArea } from "@/components/Working";
import { SUBMIT_LEAVE, VOID_LEAVE } from "@/lib/working";
import VehicleTypeChoice from "@/components/VehicleTypeChoice";
import { money } from "@/lib/money";
import OemContractRecord from "@/components/OemContractRecord";
import ProgramLabel from "@/components/admin/ProgramLabel";

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
  "fuel.type": "Gasoline, Electric or Diesel.",
  vehicle_type: "Decides the menu and the version of each product TecAssured will contract.",
  deal_type: "Cash, Finance or Lease.",
  condition: "New or Used.",
  sale_date: "YYYY-MM-DD.",
  in_service_date: "YYYY-MM-DD.",
  sale_price: "A plain number. No currency symbol needed.",
  amount_financed: "A plain number.",
  finance_term: "Whole months.",
  apr: "A percentage, as a number.",
  max_amount_financed:
    "From the finance company's approval. Leave blank if the approval has no maximum.",
};

/** Optional fields: empty is a fine answer, so they are never marked Missing. */
const OPTIONAL_FIELDS = new Set(["max_amount_financed"]);

/** The three that take a word rather than a number, so the keypad stays away. */
const TEXT_FIELDS = new Set([
  "fuel.type", "vehicle_type", "deal_type", "condition",
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

/**
 * The one marker a row can still carry: Missing.
 *
 * Where a value came from is not the presenter's business, so no row prints its
 * source: not CRM, VIN Decode, Default, or who entered it. It is still in the
 * data and the verification snapshot, and in the row's tooltip for the rare
 * person who wants it. A required field with nothing in it is the thing this
 * screen exists to catch, so that alone is still marked.
 */
function MissingMarker({ field }: { field: VerifyField }) {
  return field.source === "Missing" && !OPTIONAL_FIELDS.has(field.key)
    ? <span className="tag tag--expired">Missing</span>
    : null;
}

/**
 * One rating input, as one row: label and value.
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

  // A value changed away from what the CRM deal says gets a quiet copper edge on
  // its box, and nothing else: the details live in the warning above Confirm.
  // A value typed into an empty field, or one the CRM does not carry, is not a
  // change from the CRM and gets no edge.
  const changedFromCrm =
    field.differs_from_crm && field.original !== null && field.original_source !== "Missing";

  const state =
    field.invalid ? "is-invalid"
    : field.missing ? "is-missing"
    : changedFromCrm ? "is-changed"
    : "";

  // Shown in full only when the person has something to do about this field.
  const needsHelp = field.missing || field.invalid;

  // ── The tooltip ────────────────────────────────────────────────────────
  // Nothing on the row says where the value came from or who changed it. The
  // tooltip does, for the rare person who wants to know.
  const origin =
    field.source === "Missing" ? null
    : field.source === "CRM" ? (field.note ? null : "From the CRM deal.")
    : `Source: ${field.source}.`;

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

  const wasLine = edited
    ? `Was ${field.original ?? "not set"} (${field.original_source}), changed by ` +
      `${field.edited_by ?? "unknown"}, ${stamp(field.edited_at)}.`
    : "";

  const tip = [field.label, origin, field.note, help, wasLine, wasDetail]
    .filter(Boolean)
    .join(" ");

  // The vehicle type is a choice, first in the Vehicle panel and hard to miss.
  if (field.key === "vehicle_type" && field.editable) {
    const editedLine = edited
      ? `Entered by Staff: ${field.edited_by ?? "unknown"}, ${stamp(field.edited_at)}. ` +
        `Was ${field.original ?? "not set"} (${field.original_source}).`
      : null;
    return (
      <div id={`field-${field.key}`} className={`vfield vfield--vtype ${state}`}>
        <VehicleTypeChoice value={field.value} line={editedLine ?? field.note} edited={edited} />
      </div>
    );
  }

  return (
    <div id={`field-${field.key}`} className={`vfield ${state}`} title={tip}>
      <label className="vfield-label" htmlFor={field.editable ? id : undefined}>
        {field.label}
        {field.required ? (
          <abbr className="vfield-req" title="TecAssured asks for this">*</abbr>
        ) : null}
      </label>

      <div className="vfield-control">
        {field.editable && field.key === "fuel.type" ? (
          // A dropdown, because only three answers exist. The Gasoline default
          // shows as Gasoline, and says Default only in the tooltip. Choosing a value
          // saves as a staff edit, and choosing what the deal already says
          // without an edit leaves it as it was.
          <select id={id} name={field.key} defaultValue={field.value ?? "Gasoline"}>
            {FUEL_TYPE_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        ) : field.editable ? (
          <input
            id={id}
            type="text"
            name={field.key}
            defaultValue={field.value ?? ""}
            autoComplete="off"
            inputMode={TEXT_FIELDS.has(field.key) ? "text" : "numeric"}
            placeholder={
              field.missing ? "Needed to rate"
              : field.key === "max_amount_financed" ? "No maximum"
              : ""
            }
            aria-invalid={field.invalid ? true : undefined}
          />
        ) : (
          <p className="vfield-value">{field.value ?? <em>Not set</em>}</p>
        )}
      </div>

      <MissingMarker field={field} />

      {needsHelp && (help || field.note) ? (
        <p className="vfield-note">{help ?? field.note}</p>
      ) : null}

    </div>
  );
}

/**
 * The tab says which deal, so several open tabs can be told apart: "Deal 15029
 * Details". The same GET as the page's first read, which Next memoizes within
 * the render, so it costs no second call.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}): Promise<Metadata> {
  const { sessionId } = await params;
  if (!isSessionId(sessionId)) return { title: "Details" };
  try {
    const sheet = await edge.verifySheet<VerifySheet>(sessionId);
    const deal = sheet.session.deal_number;
    return { title: deal ? `Deal ${deal} Details` : "Details" };
  } catch {
    return { title: "Details" };
  }
}

export default async function DetailsPage({
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
      <div className="vh">
        <main className="console">
          <p className="console-empty">
            This session could not be loaded right now. Try again shortly.
          </p>
        </main>
      </div>
    );
  }

  // ── The automatic VIN decode ─────────────────────────────────────────────
  // Once per session, the first time Verify opens: a VIN, never decoded, never
  // tried. Server side, through the same function as the Decode the VIN button.
  // Never allowed to block this page: it gets a few seconds, and a failure or a
  // timeout is logged and the sheet is shown as it stands. fni-vin-decode
  // records the attempt before calling TecAssured, so an outage costs one try
  // per session. Not in fni-session-start: the CRM button must not wait on
  // TecAssured. See lib/auto-decode.ts.
  if (shouldAutoDecode(sheet)) {
    try {
      await edge.vinDecode<unknown>(sessionId, { auto: true, timeoutMs: AUTO_DECODE_TIMEOUT_MS });
    } catch (err) {
      console.error(`automatic vin decode failed for ${sessionId}:`, err);
    }
    try {
      // Fresh, because this is the same GET as the first read in the same
      // render, and Next would otherwise hand back that first, pre-decode
      // response without making the request.
      sheet = await edge.verifySheet<VerifySheet>(sessionId, { fresh: true });
    } catch (err) {
      // The sheet from before the decode is still a correct sheet to show.
      console.error(`verify sheet reload after decode failed for ${sessionId}:`, err);
    }
  }

  // The one-shot message from whatever action just ran. It arrives in a
  // short-lived cookie, not in the URL, so a provider refusal or a contract
  // number never ends up in the address bar in front of a customer or in a
  // pasted link. See lib/verify-flash.ts.
  const flashCookie = (await cookies()).get(VERIFY_FLASH_COOKIE)?.value ?? null;

  // ── A failed rating, in one plain line (lib/rating-error.ts) ──────────
  // The provider's own words, often a long fault, are kept behind "Show
  // details" in the one banner, not repeated under Rating or in the notice.
  const providers = sheet.rating.providers ?? [];
  const failedNow: RatingFailureText[] =
    sheet.rating.state !== "Failed" ? []
    : providers.some((p) => p.error)
      ? providers.filter((p) => p.error).map((p) => ({ provider: p.name, text: p.error!, at: p.error_at ?? null }))
      : ratingFailures({ detail: sheet.rating.detail, at: sheet.rating.rated_at });
  const failedKept: RatingFailureText[] = providers
    .filter((p) => p.kept_error)
    .map((p) => ({ provider: p.name, text: p.kept_error!, at: p.kept_error_at ?? null }));
  const ratingFailuresShown = [...failedNow, ...failedKept];
  const ratingHeadline =
    failedNow.length > 0 ? ratingErrorHeadline(failedNow)
    : failedKept.length > 0
      ? `The last re-rate failed, so the earlier offers are kept. ${ratingErrorHeadline(failedKept)}`
      : null;

  const decoded = decodeVerifyFlash(flashCookie);
  // A rating notice with no banner to defer to still says why in one line.
  const flash = flashMessage(
    decoded && decoded.code === "notrated" && decoded.detail && ratingFailuresShown.length === 0
      ? { ...decoded, detail: ratingErrorHeadline(ratingFailures({ detail: decoded.detail })) }
      : decoded,
    { ratingShown: ratingFailuresShown.length > 0 }
  );

  const verified = sheet.verification.state === "Verified";
  // Verified, and nothing a rate depends on has moved since. Only then is there
  // a presentation to open.
  const presentable = verified && !sheet.rating.out_of_date;
  const byGroup = (g: FieldGroup) => sheet.fields.filter((f) => f.group === g);
  const attention = sheet.fields.filter((f) => f.missing || f.invalid);

  // The rating's badge: Rated is good; Out of date and Failed need doing; the
  // rest (Not Offered, Pending) are neutral.
  const ratingTone =
    sheet.rating.out_of_date || sheet.rating.state === "Failed" ? "tag--warn"
    : sheet.rating.state === "Rated" ? "tag--good"
    : "tag--quiet";

  return (
    <WorkingArea>
    <div className="vh">
      {/* The house top bar, without the admin sidebar: Details is opened from
          the CRM and is not part of the signed-in admin area. */}
      <header className="vh-top">
        <div className="vh-crumb">
          <h1 className="sr-only">Deal {sheet.session.deal_number ?? "(no number)"} details</h1>
          <nav aria-label="Breadcrumb">
            <HomeLink />
            <span className="vh-slash" aria-hidden="true">/</span>
            Deal {sheet.session.deal_number ?? "(no number)"}
            <span className="vh-slash" aria-hidden="true">/</span>
            <strong>Details</strong>
          </nav>
        </div>
        <div className="console-who">
          {/* Who is checking this deal. One box, once per device, remembered in a
              cookie. It is a name on a record and not a sign-in: the endpoint
              refuses a verification with nobody's name on it, so the name has to
              come from somewhere, and with no accounts it comes from here. */}
          <form action={setCheckerName} className="vwho">
            <Working />
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
            <PendingButton pending="Saving your name...">
              {checker ? "Change" : "Save"}
            </PendingButton>
          </form>
          <form action={refreshFromCrm}>
            <Working />
            <input type="hidden" name="session_id" value={sheet.session.id} />
            <PendingButton working="page" pending="Refreshing from CRM...">
              Refresh from CRM
            </PendingButton>
          </form>
        </div>
      </header>

      <main className="console console--verify">
        {flash ? (
          <p
            className={flash.tone === "ok" ? "console-flash" : "console-flash console-flash--bad"}
            role="status"
            data-working-result={flash.tone}
            data-working-result-id={flashCookie ?? undefined}
          >
            {flash.text}
          </p>
        ) : null}

        {/* ── Why the rating failed: one line, the provider's text on request ── */}
        {ratingHeadline ? (
          <div className="console-flash console-flash--bad rating-banner" role="alert">
            <p className="rating-banner-say">{ratingHeadline}</p>
            {ratingFailuresShown.some(hasMoreDetail) ? (
              <details className="rating-banner-more">
                <summary>
                  <span className="rating-banner-toggle rating-banner-toggle--show">Show details</span>
                  <span className="rating-banner-toggle rating-banner-toggle--hide">Hide details</span>
                </summary>
                <RatingErrorText deal={sheet.session.deal_number} failures={ratingFailuresShown} />
              </details>
            ) : null}
          </div>
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
              <span className={`tag ${verified ? "tag--good" : "tag--warn"}`}>
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
              <span className={`tag ${ratingTone}`}>
                {sheet.rating.out_of_date ? "Out of date" : sheet.rating.state}
              </span>
              <small>
                {sheet.rating.state === "Rated"
                  ? `${sheet.rating.product_count} products, ${stamp(sheet.rating.rated_at)}`
                  : (sheet.rating.providers?.length ?? 0) > 1
                    ? "No provider rated this deal."
                    : sheet.rating.state === "Failed"
                      ? ratingErrorHeadline(failedNow) ?? "Rating failed."
                      : sheet.rating.detail ? <LongText text={sheet.rating.detail} /> : "No rate yet."}
              </small>
              {(sheet.rating.providers?.length ?? 0) > 1 ? (
                <ul className="vproviders">
                  {sheet.rating.providers!.map((p) => (
                    <li key={p.name}>
                      {p.error
                        ? ratingErrorSummary(p.name, p.error)
                        : p.kept_error
                          ? p.line.replace(/ The last re-rate failed \(.*\), so these/s, " The last re-rate failed, so these")
                          : <LongText text={p.line} />}
                    </li>
                  ))}
                </ul>
              ) : null}
            </dd>
          </div>
          {sheet.day ? (
            <div>
              <dt>Open until</dt>
              <dd>
                {storeTime(sheet.day.expires_at, sheet.day.time_zone) || "Not set"}
                <small>
                  {sheet.day.planned_sale_date
                    ? `Planned sale date ${dayLabel(sheet.day.planned_sale_date)}.`
                    : `Today at this store is ${dayLabel(sheet.day.today)}.`}
                </small>
                {/* Preparing the deal the night before: the session stays open to
                    the end of the planned day. Never sent to a provider. */}
                <form action={setPlannedSaleDate} className="vplanned" data-working-panel="">
                  <Working />
                  <input type="hidden" name="session_id" value={sheet.session.id} />
                  <label htmlFor="planned_sale_date">Planned sale date</label>
                  <input
                    id="planned_sale_date"
                    type="date"
                    name="planned_sale_date"
                    min={sheet.day.today}
                    defaultValue={sheet.day.planned_sale_date ?? ""}
                    required
                  />
                  <PendingButton pending="Saving the date...">Save date</PendingButton>
                  {sheet.day.planned_sale_date ? (
                    <PendingButton formAction={clearPlannedSaleDate} formNoValidate pending="Clearing the date...">
                      Clear
                    </PendingButton>
                  ) : null}
                </form>
              </dd>
            </div>
          ) : null}
          {sheet.menu_template ? (
            <div>
              <dt>Menu</dt>
              <dd>
                <small>{sheet.menu_template.name}</small>
                {(sheet.hidden_slots?.length ?? 0) > 0 ? (
                  <ul className="vproviders">
                    {sheet.hidden_slots!.map((h) => (
                      <li key={h.title}>{h.note ?? `${h.title} is not shown on this deal.`}</li>
                    ))}
                  </ul>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>

        {sheet.session.is_test ? (
          <p className="note note--flag">
            This is a test session. Its contracts go only to the TecAssured test
            server, and can be voided there.
          </p>
        ) : null}

        {sheet.not_ready_reason ? (
          <p className="console-flash console-flash--bad" role="alert">
            <LongText text={sheet.not_ready_reason} />
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
                <Link href={`/details/${other.id}`} prefetch={false}>
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
            {sheet.submit_detail ? <p><small><LongText text={sheet.submit_detail} /></small></p> : null}
            {operator ? (
            <form action={clearSubmitUnknown}>
              <Working />
              <input type="hidden" name="session_id" value={sheet.session.id} />
              <input
                type="text"
                name="note"
                placeholder="What you found in TecAssured (optional)"
              />
              <PendingButton working="page" pending="Clearing the notice...">
                I have checked TecAssured
              </PendingButton>
            </form>
            ) : (
              <p className="vfield-note">
                Clearing this needs a sign-in, because it is a statement that
                somebody looked at TecAssured.{" "}
                <Link href="/admin/sessions" prefetch={false}>Sign in</Link> to clear it.
              </p>
            )}
          </section>
        ) : null}

        {/* ── Paperwork that already stands ───────────────────────────────── */}
        {/* Here because this is where staff land when CRM sends a deal through a
            second time. A product with a live contract cannot be submitted again,
            and voiding is the only way to change that, so the two live together. */}
        {sheet.contracts.length > 0 && !sheet.contracts_panel ? (
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
                          {c.status === "Recorded" ? (
                            <small>An OEM contract. Void it under OEM contracts below.</small>
                          ) : !c.contract_number ? (
                            <small>No number to void by. Ask TecAssured.</small>
                          ) : operator ? (
                            <form action={voidContract} className="oem-record">
                              <Working />
                              <input type="hidden" name="session_id" value={sheet.session.id} />
                              <input
                                type="hidden"
                                name="contract_number"
                                value={c.contract_number}
                              />
                              <label>
                                <span>Why it is being voided</span>
                                <input name="void_reason" required />
                              </label>
                              <label className="vcontracts-confirm">
                                <input type="checkbox" name="confirm" required /> Cancel with TecAssured
                              </label>
                              <PendingButton working="page" pending="Voiding..." leave={VOID_LEAVE}>Void</PendingButton>
                            </form>
                          ) : (
                            <Link className="btn btn--quiet" href="/admin/sessions" prefetch={false}>
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

        {/* ── Staff contracts panel ─────────────────────────────────────────── */}
        {/* Once the customer has finished the planner: their choices, Submit,
            and each contract's document and Void. While DocuRide is being
            tested these go to TecAssured's QA server only. */}
        {sheet.contracts_panel ? (
          <section className="vcontracts" aria-labelledby="vcontracts-title">
            <h2 id="vcontracts-title">Contracts</h2>
            <ul className="vcontracts-chosen">
              {sheet.contracts_panel.selections.map((c) => (
                <li key={c.product_name}>
                  <strong>{c.product_name}</strong> <ProgramLabel name={c.program_name} />
                  <small>
                    {[
                      c.term_months ? `${c.term_months} months` : null,
                      c.term_miles ? `${c.term_miles.toLocaleString("en-US")} miles` : null,
                      c.customer_price !== null ? money(Number(c.customer_price)) : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </small>
                </li>
              ))}
            </ul>
            {sheet.submit_state === "In Progress" ? (
              <p className="console-note">A submit is running for this deal. Reload in a moment to see what came back.</p>
            ) : sheet.submit_state === "Submit Status Unknown" ? (
              <p className="console-note">Submitting is paused until the Submit Status Unknown notice above is cleared.</p>
            ) : operator ? (
              <form action={submitContracts}>
                <Working />
                <input type="hidden" name="session_id" value={sheet.session.id} />
                {sheet.contracts_panel.cobuyer_probe_available ? (
                  // TEMPORARY: the co-buyer field test. Test sessions on the
                  // QA server only; see docs/multi-provider.md, section 16.
                  <fieldset className="vprobe">
                    <label className="vprobe-check">
                      <input type="checkbox" name="cobuyer_probe" value="1" /> Co-buyer field test
                    </label>
                    <p className="vprobe-note">
                      A one-off test on this test deal. It sends made-up marker codes (CB01, CB02 and
                      so on) in many guessed co-buyer fields, so the contract shows which field
                      TecAssured prints, if any. No real names are sent. Only Battery Standard or Care
                      Coverage can be submitted with it on. Leave it off for a normal submit.
                    </p>
                    <label className="vprobe-batch">
                      Batch{" "}
                      <select name="cobuyer_probe_batch" defaultValue="All">
                        <option value="All">All</option>
                        <option value="1">Batch 1</option>
                        <option value="2">Batch 2</option>
                        <option value="3">Batch 3</option>
                      </select>
                    </label>
                  </fieldset>
                ) : null}
                {/* Contracts go out only on the day of the sale at this store
                    (_shared/store-day.ts). Submit refuses it too; this says why
                    before anyone presses it. */}
                {sheet.day?.submit_problem ? (
                  <p className="console-flash console-flash--bad" role="alert">{sheet.day.submit_problem}</p>
                ) : null}
                <PendingButton
                  className="btn"
                  working="page"
                  pending="Submitting contracts..."
                  leave={SUBMIT_LEAVE}
                  disabled={!!sheet.day?.submit_problem}
                >
                  Submit contracts to {sheet.contracts_panel.provider_name}
                </PendingButton>
              </form>
            ) : (
              <Link className="btn btn--quiet" href="/admin/sessions" prefetch={false}>
                Sign in to submit
              </Link>
            )}

            {sheet.contracts_panel.contracts.length > 0 ? (
              <ul className="vcontracts-list">
                {sheet.contracts_panel.contracts.map((c) => (
                  <li key={`${c.contract_number}-${c.document_position}`} data-working-panel="">
                    <p className="vcontracts-head">
                      <strong>{c.contract_number ?? "No number returned"}</strong> {c.product_name}{" "}
                      <ProgramLabel name={c.program_name} />{" "}
                      <span className={`tag ${c.status === "Voided" ? "tag--quiet" : "tag--good"}`}>{c.status}</span>
                    </p>
                    {c.workdrive_url ? (
                      <p>
                        <small>
                          <span className="tag tag--good">Saved to Deal Jacket</span> {stamp(c.workdrive_saved_at)}
                          {c.page_count ? `, ${c.page_count} ${c.page_count === 1 ? "page" : "pages"}` : ""}.{" "}
                          <a href={c.workdrive_url} target="_blank" rel="noreferrer">
                            Open in WorkDrive
                          </a>
                        </small>
                      </p>
                    ) : c.held ? (
                      <p>
                        <small>
                          <span className="tag tag--quiet">Waiting for Deal Jacket</span>{" "}
                          {c.status === "Voided"
                            ? "It will move with VOID in its name once the deal's folders exist."
                            : "Held in DocuRide until the deal's folders exist."}
                          {c.page_count ? ` ${c.page_count} ${c.page_count === 1 ? "page" : "pages"}.` : ""}{" "}
                          {c.view_pdf_url ? (
                            <a href={c.view_pdf_url} target="_blank" rel="noreferrer">
                              View PDF
                            </a>
                          ) : null}
                        </small>
                      </p>
                    ) : null}
                    {c.status === "Voided" ? (
                      <p>
                        <small>
                          Voided by {c.voided_by} {stamp(c.voided_at)}
                          {c.void_reason ? `: ${c.void_reason}` : "."}
                        </small>
                      </p>
                    ) : operator && c.contract_number ? (
                      <div className="vcontracts-actions">
                        <form action={getContractDocument}>
                          <Working />
                          <input type="hidden" name="session_id" value={sheet.session.id} />
                          <input type="hidden" name="contract_number" value={c.contract_number} />
                          <PendingButton pending="Getting the document...">
                            {c.workdrive_url ? "Get document again" : "Get document"}
                          </PendingButton>
                        </form>
                        <form action={voidContract} className="oem-record">
                          <Working />
                          <input type="hidden" name="session_id" value={sheet.session.id} />
                          <input type="hidden" name="contract_number" value={c.contract_number} />
                          <label>
                            <span>Why it is being voided</span>
                            <input name="void_reason" required />
                          </label>
                          <label className="vcontracts-confirm">
                            <input type="checkbox" name="confirm" required /> Cancel this contract with TecAssured
                          </label>
                          <PendingButton working="page" pending="Voiding..." leave={VOID_LEAVE}>Void</PendingButton>
                        </form>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {operator && sheet.contracts_panel.waiting_count > 0 ? (
              <form action={moveDocumentsToDealJacket} className="vcontracts-move">
                <Working />
                <input type="hidden" name="session_id" value={sheet.session.id} />
                <PendingButton working="page" pending="Moving documents to the Deal Jacket...">
                  Move documents to Deal Jacket
                </PendingButton>
                <small>
                  {sheet.contracts_panel.waiting_count}{" "}
                  {sheet.contracts_panel.waiting_count === 1 ? "document is" : "documents are"} waiting. The CRM will
                  do this on its own once DocuRide DC makes the deal&apos;s folders; this does it now.
                </small>
              </form>
            ) : null}
          </section>
        ) : null}

        {/* ── OEM contracts, recorded by staff ────────────────────────────── */}
        {/* A Price Sheet provider has no API. Its contract is written on the
            OEM's own system and recorded here with the signed document. Nothing
            on this list calls TecAssured or any other provider. */}
        {(sheet.oem_contracts?.length ?? 0) > 0 ? (
          <section className="voem" aria-labelledby="voem-title">
            <h2 id="voem-title">OEM contracts</h2>
            <p className="console-note">
              Write each of these on the OEM&apos;s own system, then record the contract
              number and the signed contract here. DocuRide does not send them anywhere.
            </p>
            <ul className="voem-list">
              {sheet.oem_contracts!.map((o) => (
                <li key={o.selected_product_id}>
                  <p className="voem-head">
                    <strong>{o.product_name}</strong> <small>{o.provider_name}</small>{" "}
                    <span className={`tag ${o.contract ? "tag--good" : "tag--quiet"}`}>
                      {o.contract ? "Recorded" : "Not recorded"}
                    </span>
                  </p>
                  {o.contract ? (
                    <>
                      <p>
                        <small>
                          Contract {o.contract.contract_number}, recorded by {o.contract.recorded_by}{" "}
                          {stamp(o.contract.recorded_at)}.{" "}
                          {o.contract.document_url ? (
                            <a href={o.contract.document_url} target="_blank" rel="noreferrer">
                              Open the signed contract
                            </a>
                          ) : null}
                        </small>
                      </p>
                      {operator ? (
                        <form action={voidOemContract} className="oem-record">
                          <Working />
                          <input type="hidden" name="session_id" value={sheet.session.id} />
                          <input type="hidden" name="contract_number" value={o.contract.contract_number} />
                          <label>
                            <span>Why it is being voided</span>
                            <input name="void_reason" required />
                          </label>
                          <PendingButton working="page" pending="Voiding the record...">Void record</PendingButton>
                        </form>
                      ) : null}
                    </>
                  ) : operator ? (
                    <OemContractRecord sessionId={sheet.session.id} selectedProductId={o.selected_product_id} />
                  ) : (
                    <Link className="btn btn--quiet" href="/admin/sessions" prefetch={false}>
                      Sign in to record
                    </Link>
                  )}
                  {o.voided.map((v) => (
                    <p key={`${v.contract_number}-${v.voided_at}`}>
                      <small>
                        Contract {v.contract_number} was voided by {v.voided_by} {stamp(v.voided_at)}: {v.void_reason}
                      </small>
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </section>
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
              <button type="submit" form="vsheet" className="btn btn--quiet">Save changes</button>
            </div>
          </aside>
        ) : null}

        {/* Each field keeps its permanent location in the review sheet. */}
        {/* Enter in a box sends this form with "Save changes" as its button;
            a vehicle type choice sends it as a whole-deal change
            (components/VehicleTypeChoice.tsx). */}
        <form
          action={saveVerifyFields}
          id="vsheet"
          className="vsheet"
          data-working="panel"
          data-working-label="Saving changes..."
        >
          <Working />
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
                {/* Over the finance company's maximum before any product is
                    added. Said plainly, and it does not block Confirm. */}
                {group === "Money" && sheet.over_cap_warning ? (
                  <p className="vgroup-warn" role="status">{sheet.over_cap_warning}</p>
                ) : null}
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
          <PendingButton form="vsheet" pending="Saving changes...">
            Save changes
          </PendingButton>

          <form
            id="vin-decode"
            action={decodeVin}
            title="Asks TecAssured what this VIN is. Fills engine size and fuel type. It does not return warranty information, so that one is always typed. This page also does this once on its own, the first time it opens."
          >
            <Working />
            <input type="hidden" name="session_id" value={sheet.session.id} />
            <PendingButton working="page" pending="Decoding the VIN...">
              Decode the VIN
            </PendingButton>
          </form>

          {decodeDidNotAnswer(sheet) ? (
            <p className="vh-notice vh-notice--warn" role="status">
              The automatic VIN decode did not answer. Press Decode the VIN to try again.
            </p>
          ) : null}

          {sheet.edited.some((f) => f.in_crm) ? (
            <form
              action={discardEdits}
              title="Puts the CRM deal back in charge of every field it carries. Engine size, factory warranty and fuel type are kept, since the CRM does not carry them and there would be nothing to reload them from."
            >
              <Working />
              <input type="hidden" name="session_id" value={sheet.session.id} />
              <PendingButton working="page" pending="Reloading from CRM...">
                Discard my edits and reload from CRM
              </PendingButton>
            </form>
          ) : null}

          <details className="vh-details">
            <summary>How this sheet works</summary>
            <p>
              * TecAssured asks for this. Hover a field to see where its value comes
              from. Clearing a box puts the original value back. Nothing is written
              back to the CRM.
              {sheet.vin_decode_at ? ` VIN last decoded ${stamp(sheet.vin_decode_at)}.` : ""}
            </p>
          </details>
        </div>
        </div>

        {/* ── The gate ───────────────────────────────────────────────────── */}
        <form action={verifyAndRate} className="vgate">
          <Working />
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
              name, the time, and each value with its source, and asks for the
              rate.
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

          <PendingButton
            className="btn btn--go"
            working="page"
            pending="Confirming and rating..."
            disabled={!sheet.ready || checker === ""}
          >
            Confirm and Continue
          </PendingButton>

          <p className="vfield-note">
            {checker === ""
              ? "Put your name in the Checked by box at the top before confirming."
              : `Confirming as ${checker}. This screen stays open afterwards.`}
          </p>

          {/* ── Open presentation ──────────────────────────────────────────
              A plain link into a new tab (target="_blank", rel="noopener"), so
              this page stays where it was and one person can work several
              deals at once. noopener leaves the customer's tab no handle back
              to this one. Pressing it again opens another tab.

              A tab opened this way has no history, so the customer cannot press
              Back into this screen, and the planner has no link of any kind to
              it. Shown only once the session is verified and its rates are
              current. */}
          {presentable ? (
            <div className="vgate-open">
              <a
                className="btn btn--go"
                href={`/plan/${sessionId}`}
                target="_blank"
                rel="noopener"
              >
                Open presentation
              </a>
              <p className="vfield-note">
                Opens in its own tab. Close that tab when you are done. This screen
                stays open for changes.
              </p>
            </div>
          ) : null}
        </form>
      </main>
    </div>
    </WorkingArea>
  );
}
