// _shared/provider-answer.ts
//
// The provider's own answer to a submit that did not simply succeed, kept so
// it can be read and sent to the provider (2026-10-28).
//
// A submit on deal 15029 at 17:29 UTC on 28 Oct 2026 ended in Submit Status
// Unknown, and only the one-line summary was saved: the provider's response,
// its HTTP status and any request ID were thrown away, so it could not be
// diagnosed. Now every submit that reaches the provider and does not end in a
// clean success keeps all three, as the session event "Provider's answer
// kept", shown on Details behind Show details with Copy error.
//
// ── What is never kept ────────────────────────────────────────────────────
// Personal details: any buyer, co-buyer or lienholder name, address, email or
// phone, whether under a key that names one or written inside a message. The
// session's own values are also searched for wherever they appear. The
// co-buyer field probe's made-up values (304-555-0101 to 0120, CB01, R01 and
// the like) stay, since they are what the probe reads for. Credentials,
// tokens and session IDs are removed outright. The answer is cut at 50,000
// characters.
//
// Pure, so a Node test can hold it.

export const PROVIDER_ANSWER_EVENT = "Provider's answer kept";

export const REDACTED = "[redacted]";
export const REMOVED = "[removed]";
const MAX_CHARS = 50_000;

/** Words in a key that mean it holds a person's details. */
const PERSONAL_WORDS = new Set([
  "name", "address", "addr", "street", "city", "zip", "zipcode", "postal", "postalcode",
  "email", "mail", "phone", "telephone", "tel", "mobile", "cell", "fax",
]);

/** A key's first word that means it names a thing, not a person: productName, dealerName. */
const THING_WORDS = new Set([
  "product", "program", "plan", "provider", "dealer", "form", "file", "document", "coverage",
  "rate", "vehicle", "model", "make", "option", "deductible", "term", "price", "tax", "field", "property",
]);

/** "cobuyerFirstName" as ["cobuyer", "first", "name"]; "postal.code" as ["postal", "code"]. */
function words(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).map((w) => w.toLowerCase()).filter(Boolean);
}

/** Does this key hold a person's details? Whole words only, so cancellationFee is not a cell phone. */
function personalKey(key: string): boolean {
  const w = words(key);
  return w.some((x) => PERSONAL_WORDS.has(x)) && !THING_WORDS.has(w[0] ?? "");
}

/** Keys that hold a secret. Their values are never kept. */
const SECRET_KEY = /session_?id|token|password|passwd|secret|api_?key|authori[sz]ation|cookie|nonce|digest|salt|username|credential/i;

/** The co-buyer field probe's made-up values, which may stay. */
const PROBE_VALUE = /^(\(?304\)?[-. ]?555[-. ]?01\d\d|(CB|R|P)\d{2}( (CB|R|P)\d{2})?|(CB|R|P)\d{2} \/ (CB|R|P)\d{2})$/;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?<!\d)(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}(?!\d)/g;

function isProbe(v: string): boolean {
  return PROBE_VALUE.test(v.trim());
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Personal text removed from free text: the session's own values, then any
 * email, then any phone number that is not a probe number.
 */
function scrubText(text: string, known: RegExp | null): string {
  let out = known ? text.replace(known, REDACTED) : text;
  out = out.replace(EMAIL, REDACTED);
  out = out.replace(PHONE, (m) => (isProbe(m) ? m : REDACTED));
  return out;
}

/** A pattern matching any of the session's personal values, or null. */
function knownPattern(known: (string | null | undefined)[]): RegExp | null {
  const vals = [...new Set(known.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length >= 3 && !isProbe(v)))];
  if (vals.length === 0) return null;
  // Longest first, so "Sample Buyer" goes before "Sample".
  vals.sort((a, b) => b.length - a.length);
  return new RegExp(vals.map(escapeRe).join("|"), "gi");
}

function walk(v: unknown, key: string | null, known: RegExp | null): unknown {
  if (key !== null && SECRET_KEY.test(key)) return REMOVED;
  if (Array.isArray(v)) return v.map((x) => walk(x, key, known));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k, known);
    return out;
  }
  if (typeof v === "string") {
    if (isProbe(v)) return v;
    if (key !== null && personalKey(key) && v.trim() !== "") return REDACTED;
    return scrubText(v, known);
  }
  if (typeof v === "number" && key !== null && personalKey(key)) {
    return isProbe(String(v)) ? v : REDACTED;
  }
  return v;
}

/** The provider's body, parsed or as text, with personal details and secrets taken out. */
export function redactProviderBody(body: unknown, known: (string | null | undefined)[] = []): unknown {
  const k = knownPattern(known);
  if (typeof body === "string") {
    // Text that is JSON is read as JSON, so its keys are known.
    try {
      return walk(JSON.parse(body), null, k);
    } catch {
      return scrubText(body, k);
    }
  }
  return walk(body, null, k);
}

/** The session's personal values, to search for wherever they appear in an answer. */
export function personalValues(session: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(session)) {
    if (!/^(buyer|cobuyer|lienholder)_/.test(k)) continue;
    if (/_(type|state)$/.test(k)) continue; // "Individual", "WV": not personal, and too short to search for safely
    if (typeof v === "string" && v.trim() !== "") out.push(v);
  }
  return out;
}

/** What a kept answer holds. */
export interface ProviderAnswer {
  /** What happened, in a few words: "Submit outcome unknown". */
  kind: string;
  /** Null when the provider never answered (a dropped connection). */
  http_status: number | null;
  request_ids: Record<string, string>;
  /** The provider's body, redacted, as it came: parsed when it was JSON. */
  body: unknown;
  /** Our own words about it, when there are any. */
  note: string | null;
  truncated: boolean;
}

/** The answer to keep, redacted and cut to size. */
export function providerAnswer(a: {
  kind: string;
  http_status: number | null;
  request_ids?: Record<string, string> | null;
  body: unknown;
  note?: string | null;
  known?: (string | null | undefined)[];
}): ProviderAnswer {
  let body = redactProviderBody(a.body ?? null, a.known ?? []);
  let truncated = false;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if ((text ?? "").length > MAX_CHARS) {
    body = `${(text ?? "").slice(0, MAX_CHARS)}...`;
    truncated = true;
  }
  const ids: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.request_ids ?? {})) if (!SECRET_KEY.test(k)) ids[k] = String(v);
  return {
    kind: a.kind,
    http_status: a.http_status,
    request_ids: ids,
    body,
    note: a.note ? scrubText(a.note, knownPattern(a.known ?? [])) : null,
    truncated,
  };
}

/** The answer as staff read and copy it on Details. */
export function providerAnswerText(a: ProviderAnswer): string {
  const ids = Object.entries(a.request_ids ?? {});
  return [
    a.kind,
    `HTTP status: ${a.http_status ?? "no answer"}`,
    `Request ID: ${ids.length > 0 ? ids.map(([k, v]) => `${v} (${k})`).join(", ") : "none sent"}`,
    a.note ? `Our note: ${a.note}` : null,
    "Provider's answer:",
    typeof a.body === "string" ? a.body : JSON.stringify(a.body, null, 2),
    a.truncated ? "(cut at 50,000 characters)" : null,
  ].filter((l): l is string => l !== null).join("\n");
}
