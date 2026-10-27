// lib/rating-error.ts: a failed rating, in one plain line.
//
// When a provider cannot rate a deal, the reason stored is its own words: often
// a SOAP fault several hundred characters long. Printed as it is, it filled the
// Rating column of the session list and was said twice on Details. So every
// screen shows one line, chosen by what kind of failure it was, and keeps the
// exact text behind "Show details", with a button to copy it for the provider's
// support.
//
// The one place the kind is decided. The session list, Details and the log the
// customer's page writes all read it here, so they never disagree. Nothing is
// stored: the kind is worked out from the stored text each time. The customer
// is never shown any of this; their screen is neutral whatever the kind.
//
// No React and no Next imports, so a Node test can hold it.

export type RatingErrorKind =
  /** We stopped before asking: a date, the vehicle type, a setup gap. */
  | "ours"
  /** The provider would not accept our login, or the login is not set up. */
  | "login"
  /** The provider's own system failed or turned the request down. */
  | "provider"
  /** Anything not recognized. */
  | "unknown";

/** One provider's failure, exactly as stored, and when it happened. */
export interface RatingFailureText {
  provider: string;
  text: string;
  at: string | null;
}

// ── Our own checks, before anything is sent ─────────────────────────────
// Each is a sentence the rating code writes itself (supabase/functions/_shared:
// deal-dates.ts, rate-session.ts, adapters/). Where that sentence is already
// plain English it is the summary; where it names code, a plain one stands in.

interface OwnReason {
  match: RegExp;
  /** The summary, or null to use the stored sentence itself. */
  say: ((provider: string) => string) | null;
}

const OWN_REASONS: OwnReason[] = [
  { match: /^Sale date is missing\b/, say: null },
  { match: /^In-service date is missing\b/, say: null },
  {
    match: /^No TecAssured vehicle type for this unit\b/,
    say: () => "No vehicle type is set for this deal. Choose one under Vehicle type on Details, then rate again.",
  },
  { match: /\bhas no adapter to rate with\b/, say: (p) => `${p} is not set up to rate deals yet. Contact an administrator.` },
  { match: /^No price sheet published for\b/, say: null },
  { match: /^Nothing on .+ sheet .+ fits this unit\b/, say: null },
  {
    match: /\bhas no active TecAssured (mapping|account)\b/,
    say: (p) => `This store is not set up with ${p}, so nothing can be rated for it. Contact an administrator.`,
  },
  { match: /^No Dealer ID for this call\b/, say: (p) => `This store has no ${p} Dealer ID. Contact an administrator.` },
];

// ── The provider would not let us in ──────────────────────────────────────
const LOGIN =
  /authentication failed|invalid credentials|login ?request failed|login ?assertion failed|refused the session|has no login or no Dealer ID|credential [^ ]+, which is missing or inactive|Failed to read .* credential|Credentials not found|\bunauthori[sz]ed\b|\b(401|403)\b/i;

// ── The provider's own system failed or said no ───────────────────────────
const PROVIDER =
  /SOAP Fault|refused the rate request|API call failed|is not answering|Could not determine what TecAssured needs|timed? ?out|timeout|\baborted\b|AbortError|ECONNRESET|ECONNREFUSED|fetch failed|network error|socket hang up|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|\b5\d\d\b/i;

function ownReason(text: string): OwnReason | null {
  return OWN_REASONS.find((r) => r.match.test(text)) ?? null;
}

/** What kind of failure a stored error text describes. */
export function ratingErrorKind(text: string | null | undefined): RatingErrorKind {
  const t = (text ?? "").trim();
  if (t === "") return "unknown";
  if (ownReason(t)) return "ours";
  if (LOGIN.test(t)) return "login";
  if (PROVIDER.test(t)) return "provider";
  return "unknown";
}

/** The page was renamed from Verify to Details; older sentences still say Verify. */
function currentNames(text: string): string {
  return text.replace(/\bon Verify\b/g, "on Details");
}

/** One plain line for one provider's failure. */
export function ratingErrorSummary(provider: string, text: string | null | undefined): string {
  const name = provider.trim() || "The provider";
  const t = (text ?? "").trim();
  switch (ratingErrorKind(t)) {
    case "ours": {
      const own = ownReason(t)!;
      return own.say ? own.say(name) : currentNames(t);
    }
    case "login":
      return `${name} did not accept our login. Contact an administrator.`;
    case "provider":
      return `${name} could not rate this deal. Their system returned an error. Try again later.`;
    default:
      return `${name} could not rate this deal.`;
  }
}

/** One line for every failed provider together. */
export function ratingErrorHeadline(failures: RatingFailureText[]): string | null {
  if (failures.length === 0) return null;
  return failures.map((f) => ratingErrorSummary(f.provider, f.text)).join(" ");
}

/**
 * The failures behind a rating, from the exact texts when the Edge Function
 * sent them, or from the older one-line detail ("Provider: text") when it did
 * not.
 */
export function ratingFailures(
  rating: { detail?: string | null; at?: string | null; failures?: RatingFailureText[] | null } | null | undefined
): RatingFailureText[] {
  if (!rating) return [];
  if (Array.isArray(rating.failures) && rating.failures.length > 0) return rating.failures;
  const detail = (rating.detail ?? "").trim();
  if (detail === "") return [];
  const m = detail.match(/^([^:]{1,60}): (.+)$/s);
  return m
    ? [{ provider: m[1].trim(), text: m[2].trim(), at: rating.at ?? null }]
    : [{ provider: "The provider", text: detail, at: rating.at ?? null }];
}

/** Whether the full text says more than the summary does. */
export function hasMoreDetail(f: RatingFailureText): boolean {
  return f.text.trim() !== ratingErrorSummary(f.provider, f.text);
}

const STAMP = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** "27 Oct 2026 13:03 UTC", or null. */
export function errorStamp(at: string | null | undefined): string | null {
  if (!at) return null;
  const d = new Date(at);
  return isNaN(d.getTime()) ? null : `${STAMP.format(d).replace(",", "")} UTC`;
}

/**
 * What "Copy error" puts on the clipboard: the deal, who and when, then the
 * provider's text exactly as stored, for sending to the provider's support.
 */
export function copyErrorText(deal: string | null | undefined, f: RatingFailureText): string {
  const when = errorStamp(f.at);
  return [
    `Deal ${deal && deal.trim() !== "" ? deal : "(no number)"}`,
    when ? `${f.provider}, ${when}` : f.provider,
    f.text,
  ].join("\n");
}
