// fni-admin-sessions/index.ts
//
// The internal session browser's data source: the most recent planner sessions,
// and the one write it needs -- pushing expires_at out so a lapsed session can
// be opened again without creating a new deal.
//
// Input:
//   GET  ?limit=25                    -> the newest sessions, newest first
//   POST { session_id, hours }        -> extend that session's expiry
//
// Auth: FNI_WEBHOOK_SECRET via x-webhook-secret header or ?secret= query param,
// exactly as fni-session-get. The browser never holds it; the console's server
// layer does, and the console's own sign-in gates who reaches that layer.
//
// ── What the list deliberately does not return ──────────────────────────
// buyer_*, cobuyer_*, lienholder_*, vin and raw_snapshot are all withheld.
// A list is browsed far more often than any one plan is opened, and none of
// those columns help answer "which session did I want". The console cannot
// leak what it is never sent, so the filtering happens here rather than in the
// page that renders it. fni-session-get withholds the same set for the same
// reason.
//
// Stock number is included and VIN is not: it identifies the unit on the lot,
// which is what someone browsing for a test session is actually matching on,
// and it is not attached to a person.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The columns the console renders. Explicit, so a new PII column on the table
 *  cannot widen this endpoint by accident. */
const LIST_COLUMNS = [
  "id",
  "deal_number",
  "status",
  "mode",
  "store_id",
  "unit_year",
  "unit_make",
  "unit_model",
  "unit_submodel",
  "stock_number",
  "created_at",
  "expires_at",
].join(",");

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const DEFAULT_EXTEND_HOURS = 24;
/** Thirty days. An internal tool reviving a test session does not need longer,
 *  and expiry is the only thing that ever retires a leaked plan link. */
const MAX_EXTEND_HOURS = 720;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

function authorized(req: Request, url: URL): boolean {
  const presented =
    req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  return secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"));
}

function admin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

/**
 * Whether the session has lapsed, decided here against one clock.
 *
 * The console must not compute this itself: its clock and this one will
 * disagree by the render latency, and a row that says "live" next to a link
 * that returns 410 is exactly the confusion the console exists to remove.
 */
function isExpired(expiresAt: unknown, now: number): boolean {
  if (typeof expiresAt !== "string") return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now;
}

async function list(url: URL): Promise<Response> {
  const asked = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(asked)
    ? Math.min(Math.max(Math.trunc(asked), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const supabase = admin();

  const { data: rows, error } = await supabase
    .schema("fni")
    .from("sessions")
    .select(LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return json(500, { error: error.message });

  const sessions = (rows ?? []) as unknown as Record<string, unknown>[];

  // Store names in one round trip. A session whose store row is missing shows
  // as null rather than falling back to the id -- a raw uuid in a "Store"
  // column reads as data corruption, and it is better to say nothing.
  const storeIds = [
    ...new Set(
      sessions
        .map((s) => s.store_id)
        .filter((v): v is string => typeof v === "string")
    ),
  ];

  const names = new Map<string, string>();
  if (storeIds.length > 0) {
    const { data: stores } = await supabase
      .from("stores")
      .select("id,name")
      .in("id", storeIds);
    for (const s of (stores ?? []) as { id: string; name: string }[]) {
      names.set(s.id, s.name);
    }
  }

  const now = Date.now();

  return json(200, {
    // Echoed so the console can say "the 25 newest" without assuming the
    // number it asked for is the number it got.
    limit,
    as_of: new Date(now).toISOString(),
    sessions: sessions.map((s) => ({
      id: s.id,
      deal_number: s.deal_number,
      status: s.status,
      mode: s.mode,
      store_name: typeof s.store_id === "string" ? names.get(s.store_id) ?? null : null,
      year: s.unit_year,
      make: s.unit_make,
      model: s.unit_model,
      submodel: s.unit_submodel,
      stock_number: s.stock_number,
      created_at: s.created_at,
      expires_at: s.expires_at,
      expired: isExpired(s.expires_at, now),
    })),
  });
}

async function extend(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "A JSON body is required" });
  }

  const sessionId = body.session_id;
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
    return json(400, { error: "A well-formed session_id is required" });
  }

  const askedHours = Number(body.hours ?? DEFAULT_EXTEND_HOURS);
  if (!Number.isFinite(askedHours) || askedHours <= 0) {
    return json(400, { error: "hours must be a positive number" });
  }
  const hours = Math.min(askedHours, MAX_EXTEND_HOURS);

  const supabase = admin();

  const { data: row, error: readErr } = await supabase
    .schema("fni")
    .from("sessions")
    .select("id,expires_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (readErr) return json(500, { error: readErr.message });
  if (!row) return json(404, { error: "Session not found" });

  const current = Date.parse((row as { expires_at: string }).expires_at);
  const now = Date.now();

  // From whichever is later: the current expiry, or now. Adding to a lapsed
  // expiry is the difference between reviving a session and doing nothing
  // visible to a session that went stale three weeks ago.
  const from = Number.isFinite(current) ? Math.max(current, now) : now;
  const next = new Date(from + hours * 3600_000).toISOString();

  const { error: writeErr } = await supabase
    .schema("fni")
    .from("sessions")
    .update({ expires_at: next })
    .eq("id", sessionId);

  if (writeErr) return json(500, { error: writeErr.message });

  console.log(
    `fni-admin-sessions extended ${sessionId} by ${hours}h to ${next}`
  );

  return json(200, {
    session_id: sessionId,
    previous_expires_at: (row as { expires_at: string }).expires_at,
    expires_at: next,
    hours,
    // It was revived rather than merely pushed out. The console says so.
    revived: Number.isFinite(current) && current <= now,
  });
}

serve(async (req: Request) => {
  const url = new URL(req.url);

  if (!authorized(req, url)) return json(401, { error: "Unauthorized" });

  try {
    if (req.method === "GET") return await list(url);
    if (req.method === "POST") return await extend(req);
    return json(405, { error: "GET or POST only" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-admin-sessions error:", message);
    return json(500, { error: message });
  }
});
