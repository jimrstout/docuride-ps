// app/page.tsx — the internal session browser.
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
import type { ConsoleListPayload, ConsoleSessionRow } from "@/lib/types";
import { signIn, signOut, extendSession, rateSession } from "./console-actions";

export const dynamic = "force-dynamic";

/** What the list shows at once. The console is for finding a recent session,
 *  not for auditing history -- that is the CRM's job. */
const LIMIT = 25;

// ── Formatting ────────────────────────────────────────────────────────────
// Times render in UTC, labelled. Guessing the reader's timezone from the
// server's would be wrong at least once a year, and quietly.

const STAMP = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

function stamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "Not set";
  return `${STAMP.format(t).replace(",", "")} UTC`;
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

/** Year, make, model, submodel — whichever of them the deal actually has. */
function vehicle(row: ConsoleSessionRow): string {
  const parts = [row.year, row.make, row.model, row.submodel]
    .map((p) => (p === null || p === undefined ? "" : String(p).trim()))
    .filter((p) => p !== "");
  return parts.length > 0 ? parts.join(" ") : "Not set";
}

// ── Sign in ───────────────────────────────────────────────────────────────

const NOTICES: Record<string, string> = {
  denied: "Those details don't match an account with access.",
  slow: "Too many attempts. Wait a minute and try again.",
  broken: "Sign-in is unavailable right now. Try again shortly.",
  extendfailed: "That session's expiry could not be extended. Try again.",
  bad: "That wasn't a valid session.",
};

function SignIn({ notice }: { notice: string | null }) {
  return (
    <main className="console console--gate">
      <form className="signin" action={signIn}>
        <p className="console-eyebrow">DocuRide PS</p>
        <h1 className="signin-title">Session browser</h1>
        <p className="signin-body">
          Sign in with your DocuRide administrator account. The same email and
          password as the admin site.
        </p>

        {notice ? (
          <p className="signin-notice" role="alert">
            {notice}
          </p>
        ) : null}

        <label className="signin-field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            autoFocus
          />
        </label>

        <label className="signin-field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
          />
        </label>

        <button type="submit" className="btn btn--go signin-submit">
          Sign in
        </button>
      </form>
    </main>
  );
}

// ── Rating ────────────────────────────────────────────────────────────────
//
// The column that answers "the planner says plans aren't offered". The customer
// sees one of two screens; staff see which of four states produced it.

const RATING: Record<string, { label: string; tone: string; note: string }> = {
  Rated: {
    label: "Rated",
    tone: "tag--live",
    note: "The customer has a menu.",
  },
  "Not Offered": {
    label: "Not offered",
    tone: "tag--quiet",
    note: "The provider has no products for this machine. The customer is told so.",
  },
  Failed: {
    label: "Failed",
    tone: "tag--expired",
    note: "Ours to fix. The customer sees a neutral message, not a refusal.",
  },
  Pending: {
    label: "Not asked yet",
    tone: "tag--quiet",
    note: "No rate has been requested. Normal on a session opened moments ago.",
  },
};

function Rating({ row, now }: { row: ConsoleSessionRow; now: number }) {
  const r = row.rating ?? { state: "Pending", detail: null, at: null };
  const meta = RATING[r.state] ?? RATING.Pending;

  return (
    <>
      <span className={`tag ${meta.tone}`}>{meta.label}</span>
      {r.at ? <small>{since(r.at, now)}</small> : null}
      {/* The provider's own words, or the field nobody filled in. This is the
          whole point of the column, so it is shown rather than hidden behind a
          hover: a reason you have to discover is a reason nobody reads. */}
      {r.detail ? <small className="cell-why">{r.detail}</small> : null}
    </>
  );
}

// ── The list ──────────────────────────────────────────────────────────────

function Row({ row, now }: { row: ConsoleSessionRow; now: number }) {
  return (
    <tr className={row.expired ? "is-expired" : undefined}>
      <td className="cell-deal">{row.deal_number ?? "Not set"}</td>

      <td className="cell-vehicle">
        <span className="cell-strong">{vehicle(row)}</span>
        {row.stock_number ? (
          <small>Stock {row.stock_number}</small>
        ) : null}
      </td>

      <td>{row.store_name ?? "Not set"}</td>

      <td>
        <span className="cell-strong">{row.status ?? "Not set"}</span>
        {row.mode ? <small>{row.mode}</small> : null}
      </td>

      <td className="cell-when">
        {stamp(row.created_at)}
        <small>{since(row.created_at, now)}</small>
      </td>

      <td className="cell-rating">
        <Rating row={row} now={now} />
      </td>

      <td className="cell-when">
        {row.expired ? (
          <span className="tag tag--expired">Expired</span>
        ) : (
          <span className="tag tag--live">Live</span>
        )}
        <small>{since(row.expires_at, now)}</small>
      </td>

      <td className="cell-do">
        <div className="cell-do-inner">
          <Link className="btn btn--quiet" href={`/plan/${row.id}`} prefetch={false}>
            Open
          </Link>
          <form action={extendSession}>
            <input type="hidden" name="session_id" value={row.id} />
            <button type="submit" className="btn btn--quiet">
              +24h
            </button>
          </form>
          {/* Verify is where rating starts now, so it is the button that is
              always here. Rate on its own is for re-asking after a failure on a
              deal that is already verified. */}
          <Link className="btn btn--quiet" href={`/verify/${row.id}`} prefetch={false}>
            Verify
          </Link>
          {row.rating?.state === "Failed" ? (
            <form action={rateSession}>
              <input type="hidden" name="session_id" value={row.id} />
              <button type="submit" className="btn btn--quiet">
                Rate
              </button>
            </form>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

async function SessionList({ email }: { email: string }) {
  let payload: ConsoleListPayload;
  try {
    payload = await edge.adminSessions<ConsoleListPayload>(LIMIT);
  } catch (err) {
    console.error("console list failed:", err);
    return (
      <main className="console">
        <p className="console-empty">
          The session list is unavailable right now. Try again shortly.
        </p>
      </main>
    );
  }

  const now = Date.parse(payload.as_of);
  const rows = payload.sessions;

  return (
    <main className="console">
      <header className="console-head">
        <div>
          <p className="console-eyebrow">DocuRide PS</p>
          <h1 className="console-title">Session browser</h1>
        </div>
        <form action={signOut} className="console-who">
          <span>{email}</span>
          <button type="submit" className="btn btn--quiet">
            Sign out
          </button>
        </form>
      </header>

      {/* The only way to reach Settings. It is deliberately not linked from
          anything customer-facing: /settings edits the words a buyer reads, so
          it lives behind the same sign-in as the session list and nowhere else. */}
      <nav className="console-tabs">
        <span className="console-tab-here">Session browser</span>
        <Link className="btn btn--quiet" href="/settings" prefetch={false}>
          Settings
        </Link>
      </nav>

      <p className="console-note">
        The {rows.length === 1 ? "most recent session" : `${rows.length} most recent sessions`},
        newest first. Times are UTC. Extending adds 24 hours from now, which
        reopens a session that has already lapsed. Rating says whether the
        customer has a menu, and why not when they do not. Verify is where you
        check what a rate would be built from; nothing is rated until somebody
        has.
      </p>

      {rows.length === 0 ? (
        <p className="console-empty">
          No planning sessions yet. One appears here as soon as a deal starts
          one from the CRM.
        </p>
      ) : (
        <div className="console-scroll">
          <table className="console-table">
            <thead>
              <tr>
                <th scope="col">Deal</th>
                <th scope="col">Vehicle</th>
                <th scope="col">Store</th>
                <th scope="col">Status</th>
                <th scope="col">Rating</th>
                <th scope="col">Created</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row key={row.id} row={row} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

export default async function ConsolePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const operator = await currentOperator();

  if (!operator) {
    const params = await searchParams;
    const key = Object.keys(NOTICES).find((k) => params[k] !== undefined);
    return <SignIn notice={key ? NOTICES[key] : null} />;
  }

  return <SessionList email={operator.email} />;
}
