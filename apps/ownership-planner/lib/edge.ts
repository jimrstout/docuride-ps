// lib/edge.ts
//
// The only place the planner's server layer talks to Supabase.
//
// The browser cannot talk to Supabase at all. anon and authenticated have zero
// table grants in the fni schema -- deliberately, because buyer PII lives in
// fni.sessions: address, phone, email and lienholder details that are kept out
// of the shared public.deals table on purpose. Every read and write goes through
// an Edge Function, and those functions authenticate with FNI_WEBHOOK_SECRET,
// which a static page cannot hold without publishing it to anyone who opens
// developer tools.
//
// So this server layer exists to hold the secret and forward calls. It contains
// no business logic: that lives in the Edge Functions, where it is already
// tested and where the service-role key lives.

import "server-only";

export class EdgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "EdgeError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Refuse a session ID that is not a well-formed UUID, so malformed input never
 * reaches an Edge Function.
 */
export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function base(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not set");
  const fns = process.env.FNI_FUNCTIONS_BASE ?? "functions/v1";
  return `${url.replace(/\/+$/, "")}/${fns.replace(/^\/+|\/+$/g, "")}`;
}

function secret(): string {
  const s = process.env.FNI_WEBHOOK_SECRET;
  if (!s) throw new Error("FNI_WEBHOOK_SECRET is not set");
  return s;
}

/**
 * Call an Edge Function.
 *
 * The secret goes in a header, never the query string, so it does not end up in
 * access logs or browser history even though the functions accept both.
 */
async function call<T>(
  fn: string,
  init: { method: "GET" | "POST"; query?: Record<string, string>; body?: unknown }
): Promise<T> {
  const url = new URL(`${base()}/${fn}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method: init.method,
    headers: {
      "x-webhook-secret": secret(),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    // Session data changes as the customer works; never serve it from a cache.
    cache: "no-store",
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const message =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : null) ?? `${fn} failed with ${res.status}`;
    throw new EdgeError(res.status, message, parsed);
  }

  return parsed as T;
}

export const edge = {
  sessionGet: <T>(sessionId: string) =>
    call<T>("fni-session-get", { method: "GET", query: { session_id: sessionId } }),

  sessionSave: <T>(body: unknown) =>
    call<T>("fni-session-save", { method: "POST", body }),

  rate: <T>(body: unknown) => call<T>("fni-rate-vehicle", { method: "POST", body }),

  submit: <T>(body: unknown) =>
    call<T>("fni-contract-submit", { method: "POST", body }),

  documents: <T>(body: unknown) =>
    call<T>("fni-contract-documents", { method: "POST", body }),
};
