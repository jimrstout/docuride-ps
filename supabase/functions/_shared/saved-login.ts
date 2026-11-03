// _shared/saved-login.ts: whether a saved provider login may be sent.
//
// Pure, so a Node test can hold it. Used by clientFor (_shared/tecassured.ts).

/** How long a login is kept for reuse: 25 minutes against TecAssured's 30. */
export const LOGIN_LIFETIME_MS = 25 * 60 * 1000;

export interface SavedLogin {
  /** Who made the saved login offered to this client. */
  from: "this instance" | "another instance" | "none";
  /** Its age in seconds when the client was built, or null with none. */
  age_s: number | null;
  /** Whether the client was allowed to send it. */
  used: boolean;
}

/**
 * Whether a saved login may be sent, and how old it is.
 *
 * ── Only a login this instance made (3 Nov 2026) ──────────────────────────
 * TecAssured refuses a login sent from another Edge Function instance than
 * the one that made it, whatever its age: 28, 51 and 67 seconds old, refused,
 * each sent by a new instance; 30 seconds to over 2 minutes old, accepted,
 * each sent by the instance that made it (rate and probe logs, 2 and 3 Nov).
 * Each refusal cost a wasted call, a login and a resend, about 1.5 seconds of
 * a rate. So a login another instance kept on the credential row is never
 * sent: this instance logs in first. A login it made itself is sent for the
 * usual 25 minutes. A refusal is still met with one login and one resend.
 */
export function savedLoginFor(
  own: { sessionId: string | null; expiresAt: string | null } | undefined,
  row: { session_id_cached: string | null; session_expires_at: string | null },
  now = Date.now()
): SavedLogin {
  const age = (expiresAt: string | null) => {
    const t = expiresAt ? Date.parse(expiresAt) : NaN;
    return Number.isFinite(t) ? Math.max(0, Math.round((now - (t - LOGIN_LIFETIME_MS)) / 1000)) : null;
  };
  const live = (id: string | null, expiresAt: string | null) =>
    !!id && !!expiresAt && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > now;
  if (own && live(own.sessionId, own.expiresAt)) return { from: "this instance", age_s: age(own.expiresAt), used: true };
  if (live(row.session_id_cached, row.session_expires_at)) {
    return { from: "another instance", age_s: age(row.session_expires_at), used: false };
  }
  return { from: "none", age_s: null, used: false };
}
