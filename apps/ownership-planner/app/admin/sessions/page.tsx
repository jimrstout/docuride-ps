// app/admin/sessions/page.tsx: the internal session browser.
//
// A way into a planning session without copying a link out of the CRM. Nothing
// customer-facing renders here and nothing customer-facing links to it; it is
// the operator's door, and the planner itself never mentions it.
//
// ── The order of the two halves matters ─────────────────────────────────
// The sign-in check happens before the list is fetched, not before it is
// displayed. An unauthenticated request never causes a read of fni.sessions at
// all, so there is no rendered-but-hidden data, no payload in the HTML that a
// stylesheet is hiding, and nothing in a server log about a list nobody was
// allowed to see.
//
// ── And the list is fetched the way a plan is ───────────────────────────
// Through lib/edge.ts, server-side, on FNI_WEBHOOK_SECRET. The browser holds no
// Supabase key and makes no Supabase request, exactly as on /plan. The console
// adds a door; it does not add a route to the data.

import Link from "next/link";
import { currentOperator } from "@/lib/admin-session";
import { edge } from "@/lib/edge";
import type { ConsoleListPayload, ConsoleSessionRow, PricingPayload } from "@/lib/types";
import { SIGN_IN_NOTICES } from "@/components/admin/SignIn";
import { Badge, Notice, PageHead, type Tone } from "@/components/admin/Parts";
import { SessionFilters, type FilterOption } from "@/components/admin/SessionFilters";
import { extendSession, rateSession } from "@/app/console-actions";

export const dynamic = "force-dynamic";

/** What the list shows at once. The console is for finding a recent session,
 *  not for auditing history -- that is the CRM's job. */
const LIMIT = 25;

/**
 * Every status a session can have, as stored. The same list as the check
 * constraint on fni.sessions.status, in the order a session moves through
 * them, so the Status filter offers real values and nothing invented.
 */
const SESSION_STATUSES = [
  "Initiated",
  "Rated",
  "Presenting",
  "Products Selected",
  "Agreement Created",
  "Finalized",
  "Written Back",
  "Cancelled",
] as const;

// ── Formatting ────────────────────────────────────────────────────────────
// Times render in UTC, labelled. Guessing the reader's timezone from the
// server's would be wrong at least once a year, and quietly.

const DAY = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

function day(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DAY.format(t) : "Not set";
}

function clock(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${CLOCK.format(t)} UTC` : "";
}

/**
 * "in 5 hours" / "3 days ago", against the clock the Edge Function used.
 *
 * Passing `now` in rather than reading it here is what keeps the words and the
 * Expired mark agreeing with each other: both come from the same instant, so a
 * row can never read "expired" beside "in 2 minutes".
 */
function since(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const seconds = Math.round((t - now) / 1000);
  const ago = seconds < 0;
  const abs = Math.abs(seconds);

  const [value, unit] =
    abs < 90 ? [abs, "second"]
    : abs < 5400 ? [Math.round(abs / 60), "minute"]
    : abs < 129_600 ? [Math.round(abs / 3600), "hour"]
    : [Math.round(abs / 86_400), "day"];

  const plural = value === 1 ? unit : `${unit}s`;
  return ago ? `${value} ${plural} ago` : `in ${value} ${plural}`;
}

/** Year, make, model, submodel: whichever of them the deal actually has. */
function vehicle(row: ConsoleSessionRow): string {
  const parts = [row.year, row.make, row.model, row.submodel]
    .map((p) => (p === null || p === undefined ? "" : String(p).trim()))
    .filter((p) => p !== "");
  return parts.length > 0 ? parts.join(" ") : "Not set";
}

function statusTone(status: string | null): Tone {
  if (status === "Presenting") return "good";
  return "plain";
}

// ── Rating ────────────────────────────────────────────────────────────────
//
// The column that answers "the planner says plans aren't offered". The customer
// sees one of two screens; staff see which of four states produced it.

const RATING: Record<string, { label: string; tone: Tone; note: string }> = {
  Rated: {
    label: "Rated",
    tone: "good",
    note: "The customer has a menu.",
  },
  "Not Offered": {
    label: "Not offered",
    tone: "plain",
    note: "The provider has no products for this machine. The customer is told so.",
  },
  Failed: {
    label: "Failed",
    tone: "warn",
    note: "Ours to fix. The customer sees a neutral message, not a refusal.",
  },
  Pending: {
    label: "Not asked yet",
    tone: "plain",
    note: "No rate has been requested. Normal on a session opened moments ago.",
  },
};

function Rating({ row, now }: { row: ConsoleSessionRow; now: number }) {
  const r = row.rating ?? { state: "Pending", detail: null, at: null };
  const meta = RATING[r.state] ?? RATING.Pending;

  return (
    <>
      <Badge tone={meta.tone}>{meta.label}</Badge>
      {r.at ? <small>{since(r.at, now)}</small> : null}
      {/* The provider's own words, or the field nobody filled in. This is the
          whole point of the column, so it is shown rather than hidden behind a
          hover: a reason you have to discover is a reason nobody reads. */}
      {r.detail ? <small className="ad-why">{r.detail}</small> : null}
    </>
  );
}

// ── The list ──────────────────────────────────────────────────────────────

/** What the search box looks through, lower case. The VIN is not here: the
 *  Edge Function never sends it to the console. */
function searchText(row: ConsoleSessionRow): string {
  return [row.deal_number, row.stock_number, vehicle(row), row.store_name]
    .filter((v) => v !== null && v !== undefined)
    .join(" ")
    .toLowerCase();
}

function Row({ row, now }: { row: ConsoleSessionRow; now: number }) {
  const ratingState = row.rating?.state ?? "Pending";
  return (
    <tr
      data-row=""
      data-store={row.store_name ?? ""}
      data-status={row.status ?? ""}
      data-rating={ratingState}
      data-search={searchText(row)}
    >
      <td className="ad-deal">{row.deal_number ?? "Not set"}</td>

      <td>
        <span className="ad-strong">{vehicle(row)}</span>
        {row.stock_number ? <small>Stock {row.stock_number}</small> : null}
      </td>

      <td>{row.store_name ?? "Not set"}</td>

      <td>
        <Badge tone={statusTone(row.status)}>{row.status ?? "Not set"}</Badge>
        {row.mode ? <small>{row.mode}</small> : null}
      </td>

      <td>
        <Rating row={row} now={now} />
      </td>

      <td style={{ whiteSpace: "nowrap" }}>
        {day(row.created_at)}
        <small>{clock(row.created_at)}</small>
      </td>

      <td style={{ whiteSpace: "nowrap" }}>
        {row.expired ? (
          <Badge tone="warn">Expired</Badge>
        ) : (
          <Badge tone="good">Active</Badge>
        )}
        <small>{row.expired ? "Extension available" : since(row.expires_at, now)}</small>
      </td>

      <td>
        <div className="ad-actions">
          <Link className="ad-btn ad-btn--secondary ad-btn--main" href={`/plan/${row.id}`} prefetch={false}>
            Open
          </Link>
          <form action={extendSession}>
            <input type="hidden" name="session_id" value={row.id} />
            <button type="submit" className="ad-btn ad-btn--secondary">
              +24h
            </button>
          </form>
          {/* Verify is where rating starts now, so it is the button that is
              always here. Rate on its own is for re-asking after a failure on a
              deal that is already verified. */}
          <Link className="ad-btn ad-btn--secondary" href={`/verify/${row.id}`} prefetch={false}>
            Verify
          </Link>
          {row.rating?.state === "Failed" ? (
            <form action={rateSession}>
              <input type="hidden" name="session_id" value={row.id} />
              <button type="submit" className="ad-btn ad-btn--secondary">
                Rate
              </button>
            </form>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

/**
 * The stores the menu runs at, for the Store filter: those with an active
 * TecAssured account, read the same way the Pricing page reads them. If that
 * read fails, the stores that appear in the list stand in, so the filter
 * still works.
 */
async function menuStores(rows: ConsoleSessionRow[]): Promise<FilterOption[]> {
  try {
    const pricing = await edge.adminPricing<PricingPayload>({ scope: "all" });
    return pricing.stores.map((s) => ({ value: s.name, label: s.name }));
  } catch (err) {
    console.error("console store list failed:", err);
    const names = [...new Set(rows.map((r) => r.store_name).filter((n): n is string => !!n))].sort();
    return names.map((n) => ({ value: n, label: n }));
  }
}

async function SessionList({ notice }: { notice: string | null }) {
  let payload: ConsoleListPayload;
  try {
    payload = await edge.adminSessions<ConsoleListPayload>(LIMIT);
  } catch (err) {
    console.error("console list failed:", err);
    return (
      <>
        <PageHead title="Sessions" subtitle="Ownership presentations opened from the CRM." />
        <Notice tone="warn">The session list is unavailable right now. Try again shortly.</Notice>
      </>
    );
  }

  const now = Date.parse(payload.as_of);
  const rows = payload.sessions;
  const stores = await menuStores(rows);

  return (
    <>
      <PageHead title="Sessions" subtitle="Ownership presentations opened from the CRM." />

      {/* An extend or rate that could not be done says so here. These used to
          be read only by the sign-in form, so a signed-in operator never saw
          them. */}
      {notice ? <Notice tone="warn">{notice}</Notice> : null}

      <section className="ad-panel">
        <SessionFilters
          tableId="ad-sessions"
          countId="ad-sessions-count"
          stores={stores}
          statuses={SESSION_STATUSES.map((s) => ({ value: s, label: s }))}
          ratings={Object.entries(RATING).map(([value, r]) => ({ value, label: r.label }))}
        />

        {rows.length === 0 ? (
          <p className="ad-empty">
            No planning sessions yet. One appears here as soon as a deal starts
            one from the CRM.
          </p>
        ) : (
          <div className="ad-scroll">
            <table className="ad-table" id="ad-sessions">
              <thead>
                <tr>
                  <th scope="col">Deal #</th>
                  <th scope="col">Vehicle</th>
                  <th scope="col">Store</th>
                  <th scope="col">Status</th>
                  <th scope="col">Rating</th>
                  <th scope="col">Created</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Row key={row.id} row={row} now={now} />
                ))}
                <tr data-none="" hidden>
                  <td colSpan={8} className="ad-empty">
                    No sessions match. Clear the search or a filter to see more.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <footer className="ad-panel-foot">
          <span id="ad-sessions-count">
            {rows.length} {rows.length === 1 ? "session" : "sessions"}
          </span>
          <span>Most recent first</span>
        </footer>
      </section>

      <details className="ad-details">
        <summary>Session timing and ratings</summary>
        <p>
          The list shows the {rows.length === 1 ? "most recent session" : `${rows.length} most recent sessions`},
          newest first. Times are UTC. Extending adds 24 hours from now, which
          reopens a session that has already lapsed. Rating says whether the
          customer has a menu, and why not when they do not. Verify is where you
          check what a rate would be built from; nothing is rated until somebody
          has.
        </p>
      </details>
    </>
  );
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The layout shows the sign-in form to anyone not signed in. Checked here as
  // well, from the same cached answer, so nothing is fetched for them.
  const operator = await currentOperator();
  if (!operator) return null;

  const params = await searchParams;
  const key = ["extendfailed", "bad"].find((k) => params[k] !== undefined);
  return <SessionList notice={key ? SIGN_IN_NOTICES[key] : null} />;
}
