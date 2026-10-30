// fni-admin-sessions/index.ts
//
// The internal session browser's data source: the most recent planner sessions.
//
// Input:
//   GET  ?limit=25   -> the newest sessions, newest first
//   POST             -> 410. Renew for Today is retired (2026-10-30): a session
//                       is open through 23:59:59 on its CRM sale date at the
//                       store (migration 0044), and the sale date is changed in
//                       the CRM only (_shared/crm-sale-date.ts).
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
import { currentRows, ratingSummary, type RatingFailure, type RatingRow } from "../_shared/rating-summary.ts";

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
  // Which providers the latest rating covered. Multi-provider Part 4.
  "rated_provider_ids",
].join(",");

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;


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
  const zones = new Map<string, string | null>();
  if (storeIds.length > 0) {
    const { data: stores } = await supabase
      .from("stores")
      .select("id,name,time_zone")
      .in("id", storeIds);
    for (const s of (stores ?? []) as { id: string; name: string; time_zone: string | null }[]) {
      names.set(s.id, s.name);
      zones.set(s.id, s.time_zone ?? null);
    }
  }

  // ── Why a session has no menu ──────────────────────────────────────────
  // The customer is deliberately not told which of the four states they are in.
  // Staff are: this column is the only place the reason a rate failed is
  // readable without going into the database, and "the planner said plans
  // aren't offered" is a support call somebody has to be able to answer.
  const sessionIds = sessions
    .map((s) => s.id)
    .filter((v): v is string => typeof v === "string");

  const rating = new Map<string, { state: string; detail: string | null; at: string | null; failures: RatingFailure[] }>();
  if (sessionIds.length > 0) {
    const { data: offers } = await supabase
      .schema("fni")
      .from("rated_offers")
      // Every provider's attempt per session, summed the way Verify sums them.
      .select("session_id, provider_id, state, error_detail, last_failure_detail, last_failure_at, product_count, rated_at, out_of_date, provider:providers(id, name, kind, adapter)")
      .in("session_id", sessionIds);

    const bySession = new Map<string, RatingRow[]>();
    // The quotes themselves are not read: a summary needs states and counts.
    for (const o of (offers ?? []) as unknown as (Omit<RatingRow, "response_payload"> & { session_id: string })[]) {
      const list = bySession.get(o.session_id) ?? [];
      list.push({ ...o, response_payload: null });
      bySession.set(o.session_id, list);
    }
    for (const sess of sessions) {
      const rows = bySession.get(String(sess.id));
      if (!rows) continue;
      const summary = ratingSummary(currentRows(rows, sess.rated_provider_ids as string[] | null));
      rating.set(String(sess.id), {
        state: summary.state,
        detail: summary.state === "Rated" ? null : summary.detail,
        at: summary.rated_at,
        // The exact provider text behind the one-line summary the console
        // shows. Read by apps/ownership-planner/lib/rating-error.ts.
        failures: summary.state === "Rated" ? [] : summary.failures,
      });
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
      time_zone: typeof s.store_id === "string" ? zones.get(s.store_id) ?? null : null,

      // No row means nobody has asked the provider yet. That is a real and
      // common state on a session created moments ago, so it is named rather
      // than folded into one of the outcomes.
      rating: rating.get(String(s.id)) ?? { state: "Pending", detail: null, at: null, failures: [] },
    })),
  });
}

serve(async (req: Request) => {
  const url = new URL(req.url);

  if (!authorized(req, url)) return json(401, { error: "Unauthorized" });

  try {
    if (req.method === "GET") return await list(url);
    if (req.method === "POST") {
      return json(410, {
        error: "Renew for Today is retired. A session is open through its sale date; change the Sale Date in the CRM.",
      });
    }
    return json(405, { error: "GET or POST only" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-admin-sessions error:", message);
    return json(500, { error: message });
  }
});
