// app/admin/price-sheets/[sheetId]/page.tsx: reviewing and publishing one sheet.
//
// What Claude read, one rate per row, with what each fits, its term, its money,
// where on the sheet it came from and how sure the reading was. The server
// checks flag anything that looks wrong, with the reason. Staff correct a rate,
// or leave it out with a reason (it is kept as the record and never offered);
// nothing is deleted. Publishing is refused while any rate not left out is
// flagged, and retires the provider's overlapping Published sheet.
//
// No JavaScript: ?edit=<rate id> opens the correction form, ?show=flagged
// narrows the table.

import Link from "next/link";
import { notFound } from "next/navigation";
import { currentOperator } from "@/lib/admin-session";
import { edge, EdgeError } from "@/lib/edge";
import type { PriceSheetRateRow, PriceSheetRow } from "@/lib/types";
import { dateLine, fitsLine, rateMoney, statusTone, termLine } from "@/lib/price-sheets";
import {
  editSheetRate,
  includeRate,
  leaveOutRate,
  parsePriceSheet,
  publishSheet,
  retireSheet,
} from "@/app/console-actions";
import { Badge, Notice, PageHead } from "@/components/admin/Parts";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CATEGORIES = ["Mechanical Protection", "Maintenance", "Tire and Wheel", "Theft", "Battery", "Appearance", "Other"];

function notice(params: Params): { tone: "good" | "warn"; text: string } | null {
  if (params.uploaded !== undefined) return { tone: "good", text: "Uploaded. Claude is reading it now; this page shows the rates when it is done." };
  if (params.reading !== undefined) return { tone: "good", text: "Claude is reading it now. Refresh in a minute." };
  if (params.saved !== undefined) return { tone: "good", text: "Saved. The checks have run again." };
  if (params.leftout !== undefined) return { tone: "good", text: "Left out. It is kept here and never offered." };
  if (params.published !== undefined) return { tone: "good", text: "Published. It is used for the next deal rated." };
  if (params.retired !== undefined) return { tone: "good", text: "Retired. It is no longer used." };
  if (typeof params.refused === "string") return { tone: "warn", text: params.refused };
  if (params.savefailed !== undefined) return { tone: "warn", text: "That could not be saved just now. Nothing was changed. Try again shortly." };
  return null;
}

const listText = (l: string[]) => l.join(", ");
const numText = (v: number | string | null) => (v === null ? "" : String(v));

function RateForm({ sheetId, r }: { sheetId: string; r: PriceSheetRateRow }) {
  const field = (name: keyof PriceSheetRateRow, label: string, value: string, wide = false) => (
    <label className={wide ? "ad-field ad-field--wide" : "ad-field"}>
      <span>{label}</span>
      <input name={name} defaultValue={value} />
    </label>
  );
  return (
    <section className="ad-panel ad-editor" aria-labelledby="rate-form">
      <div className="ad-panel-head"><h2 id="rate-form">Correct {r.product_name}</h2></div>
      <div className="ad-panel-body">
        <form action={editSheetRate} className="ad-editor-fields">
          <input type="hidden" name="sheet_id" value={sheetId} />
          <input type="hidden" name="rate_id" value={r.id} />
          {field("product_code", "Product code", r.product_code)}
          {field("product_name", "Product name", r.product_name)}
          {field("family_code", "Decision group (tiers of one plan share it)", r.family_code ?? "")}
          {field("plan", "Plan or tier", r.plan ?? "")}
          <label className="ad-field">
            <span>Category</span>
            <select name="category" defaultValue={r.category ?? ""}>
              <option value="">None</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {field("makes", "Makes", listText(r.makes))}
          {field("model_contains", "Model contains", listText(r.model_contains))}
          {field("vehicle_types", "Vehicle types", listText(r.vehicle_types))}
          {field("conditions", "New or Used", listText(r.conditions))}
          {field("year_min", "First model year", numText(r.year_min))}
          {field("year_max", "Last model year", numText(r.year_max))}
          {field("max_age_years", "Maximum age in years", numText(r.max_age_years))}
          {field("max_odometer", "Maximum odometer", numText(r.max_odometer))}
          {field("engine_cc_min", "Smallest engine (cc)", numText(r.engine_cc_min))}
          {field("engine_cc_max", "Largest engine (cc)", numText(r.engine_cc_max))}
          {field("max_months_in_service", "Maximum months in service", numText(r.max_months_in_service))}
          {field("term_months", "Term (months)", numText(r.term_months))}
          {field("term_miles", "Term (miles)", numText(r.term_miles))}
          {field("deductible", "Deductible ($)", numText(r.deductible))}
          {field("dealer_cost", "Dealer cost ($)", numText(r.dealer_cost))}
          {field("suggested_retail", "Suggested retail ($)", numText(r.suggested_retail))}
          <div className="ad-editor-actions ad-field--wide">
            <button type="submit" className="ad-btn ad-btn--primary">Save correction</button>
            <Link href={`/admin/price-sheets/${sheetId}`} prefetch={false} className="ad-btn ad-btn--secondary">Cancel</Link>
          </div>
        </form>
      </div>
    </section>
  );
}

function RateStatus({ r }: { r: PriceSheetRateRow }) {
  if (r.left_out) return <><Badge>Left out</Badge><small>{r.left_out_reason}</small></>;
  if (r.flagged) return <><Badge tone="warn">Flagged</Badge><small>{r.flag_reason}</small></>;
  return <Badge tone="good">Ready</Badge>;
}

export default async function SheetPage({
  params: routeParams,
  searchParams,
}: {
  params: Promise<{ sheetId: string }>;
  searchParams: Promise<Params>;
}) {
  const operator = await currentOperator();
  if (!operator) return null;
  const { sheetId } = await routeParams;
  if (!UUID_RE.test(sheetId)) notFound();
  const params = await searchParams;

  let sheet: PriceSheetRow;
  let rates: PriceSheetRateRow[];
  try {
    ({ sheet, rates } = await edge.priceSheets<{ sheet: PriceSheetRow; rates: PriceSheetRateRow[] }>({ sheet_id: sheetId }));
  } catch (err) {
    if (err instanceof EdgeError && err.status === 404) notFound();
    console.error("price sheet load failed:", err);
    return (
      <>
        <PageHead title="Price sheet" subtitle="Review and publish." />
        <Notice tone="warn">This sheet is unavailable right now. Try again shortly.</Notice>
      </>
    );
  }

  const flash = notice(params);
  const draft = sheet.status === "Draft";
  const counted = rates.filter((r) => !r.left_out);
  const flagged = counted.filter((r) => r.flagged).length;
  const shown = one(params.show) === "flagged" ? rates.filter((r) => r.flagged && !r.left_out) : rates;
  const editing = draft ? rates.find((r) => r.id === one(params.edit)) ?? null : null;

  return (
    <>
      <PageHead title={sheet.name} subtitle={`${dateLine(sheet)}. ${sheet.file_name}, uploaded by ${sheet.uploaded_by}.`}>
        <Link href={`/admin/price-sheets?provider=${sheet.provider_id}`} prefetch={false} className="ad-btn ad-btn--secondary">
          All of this provider&apos;s sheets
        </Link>
      </PageHead>
      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <section className="ad-panel" aria-labelledby="sheet-state">
        <div className="ad-panel-head">
          <h2 id="sheet-state">
            <Badge tone={statusTone(sheet)}>{sheet.status}</Badge> {sheet.parse_status}
          </h2>
        </div>
        <div className="ad-panel-body">
          {sheet.parse_status === "Parsing" ? <p>Claude is reading this sheet now. Refresh in a minute.</p> : null}
          {sheet.parse_notes ? <p className="ad-notes">{sheet.parse_notes}</p> : null}
          {sheet.model ? (
            <p className="ad-help">
              Read by {sheet.model}
              {sheet.input_tokens !== null ? `, ${sheet.input_tokens.toLocaleString("en-US")} tokens in and ${(sheet.output_tokens ?? 0).toLocaleString("en-US")} out` : ""}
              {sheet.parse_seconds !== null ? `, in ${sheet.parse_seconds} seconds` : ""}.
            </p>
          ) : null}
          {sheet.published_by ? <p className="ad-help">Published by {sheet.published_by}.</p> : null}
          {sheet.retired_reason ? <p className="ad-help">Retired: {sheet.retired_reason}</p> : null}

          <div className="ad-actions">
            {draft && rates.length === 0 && sheet.parse_status !== "Parsing" ? (
              <form action={parsePriceSheet}>
                <input type="hidden" name="sheet_id" value={sheet.id} />
                <button type="submit" className="ad-btn ad-btn--primary">Read with Claude</button>
              </form>
            ) : null}
            {draft && sheet.parse_status === "Parsed" ? (
              <form action={publishSheet}>
                <input type="hidden" name="sheet_id" value={sheet.id} />
                <button type="submit" className="ad-btn ad-btn--primary" disabled={flagged > 0 || counted.length === 0}>
                  Publish {counted.length} {counted.length === 1 ? "rate" : "rates"}
                </button>
              </form>
            ) : null}
            {sheet.status !== "Retired" ? (
              <form action={retireSheet} className="ad-row">
                <input type="hidden" name="sheet_id" value={sheet.id} />
                <input name="reason" placeholder="Why it is being retired" aria-label="Why it is being retired" required />
                <button type="submit" className="ad-btn ad-btn--secondary">Retire</button>
              </form>
            ) : null}
          </div>
          {draft && flagged > 0 ? (
            <p className="ad-help">
              {flagged} {flagged === 1 ? "rate is" : "rates are"} flagged. Correct {flagged === 1 ? "it" : "them"}, or leave{" "}
              {flagged === 1 ? "it" : "them"} out, before publishing.{" "}
              <Link href={`/admin/price-sheets/${sheet.id}?show=flagged`} prefetch={false}>Show only flagged rates</Link>
            </p>
          ) : null}
        </div>
      </section>

      {editing ? <RateForm sheetId={sheet.id} r={editing} /> : null}

      <section className="ad-panel" aria-labelledby="rates-title">
        <div className="ad-panel-head">
          <h2 id="rates-title">{rates.length} {rates.length === 1 ? "rate" : "rates"} read</h2>
          {one(params.show) === "flagged" ? (
            <Link href={`/admin/price-sheets/${sheet.id}`} prefetch={false} className="ad-btn ad-btn--secondary">Show all</Link>
          ) : null}
        </div>
        <div className="ad-scroll">
          <table className="ad-table ad-rates">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Fits</th>
                <th scope="col">Term</th>
                <th scope="col" className="num">Deductible</th>
                <th scope="col" className="num">Dealer cost</th>
                <th scope="col" className="num">Suggested retail</th>
                <th scope="col">Read from</th>
                <th scope="col">Status</th>
                {draft ? <th scope="col"><span className="sr-only">Actions</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr><td colSpan={draft ? 9 : 8} className="ad-empty">No rates to show.</td></tr>
              ) : null}
              {shown.map((r) => (
                <tr key={r.id}>
                  <td><span className="ad-strong">{r.product_name}</span><small>{[r.product_code, r.plan].filter(Boolean).join(", ")}</small></td>
                  <td>{fitsLine(r)}</td>
                  <td>{termLine(r)}</td>
                  <td className="num">{rateMoney(r.deductible)}</td>
                  <td className="num">{rateMoney(r.dealer_cost)}</td>
                  <td className="num">{rateMoney(r.suggested_retail)}</td>
                  <td>{r.source_ref ?? "Not given"}<small>{r.confidence} confidence{r.model_note ? `: ${r.model_note}` : ""}</small></td>
                  <td><RateStatus r={r} /></td>
                  {draft ? (
                    <td>
                      <div className="ad-actions">
                        <Link href={`/admin/price-sheets/${sheet.id}?edit=${r.id}`} prefetch={false} className="ad-btn ad-btn--secondary">Correct</Link>
                        {r.left_out ? (
                          <form action={includeRate}>
                            <input type="hidden" name="sheet_id" value={sheet.id} />
                            <input type="hidden" name="rate_id" value={r.id} />
                            <button type="submit" className="ad-btn ad-btn--secondary">Include</button>
                          </form>
                        ) : (
                          <form action={leaveOutRate} className="ad-row">
                            <input type="hidden" name="sheet_id" value={sheet.id} />
                            <input type="hidden" name="rate_id" value={r.id} />
                            <input name="reason" placeholder="Why" aria-label={`Why ${r.product_name} is left out`} required />
                            <button type="submit" className="ad-btn ad-btn--secondary">Leave out</button>
                          </form>
                        )}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
