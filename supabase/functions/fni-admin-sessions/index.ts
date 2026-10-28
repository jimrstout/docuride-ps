// fni-admin-sessions/index.ts
//
// The internal session browser's data source: the most recent planner sessions,
// and the one write it needs -- Renew for Today, so a lapsed session can be
// opened again without creating a new deal.
//
// Input:
//   GET  ?limit=25                    -> the newest sessions, newest first
//   POST { session_id, renewed_by? }  -> Renew for Today: a sale date or
//                                        planned sale date before today moves
//                                        to today, then the session lasts to
//                                        the end of its store's day, or of its
//                                        planned sale date when that is later.
//                                        renewed_by is the signed-in person's
//                                        initials; without it, System.
//
// ── Renew for Today, not +24h ───────────────────────────────────────────
// +24h added 24 hours a press, so two presses stacked (deal 13437 gained 48).
// A session now lasts to 23:59:59 on its store's day (migration 0038), and
// renewing sets that same moment again: a second press changes nothing. An
// older console that still sends { hours } is renewed the same way.
//
// ── Past dates move to today (2026-10-28) ───────────────────────────────
// A deal prepared yesterday still said yesterday, and Submit takes only the
// day of the sale. So a sale date or planned sale date before today at the
// store moves to today first; today or later is left alone, so a deal
// prepared for tomorrow keeps tomorrow. The sale date moves as a staff edit
// over the CRM's, and each move is a session event naming who did it. A moved
// sale date marks the rates out of date, since it is sent in the rate request,
// and a verified deal goes back through Confirm and Continue. No price is
// touched. See _shared/sale-date.ts.
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
import { storeToday } from "../_shared/store-day.ts";
import { applyStaffEdits, parseStaffEdits } from "../_shared/staff-edits.ts";
import {
  dateMoveEvent,
  movedSaleDateEdit,
  renewDateMoves,
  renewedBy,
  renewExtends,
  renewOffered,
} from "../_shared/sale-date.ts";

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
  "planned_sale_date",
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
  if (storeIds.length > 0) {
    const { data: stores } = await supabase
      .from("stores")
      .select("id,name")
      .in("id", storeIds);
    for (const s of (stores ?? []) as { id: string; name: string }[]) {
      names.set(s.id, s.name);
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

  // ── What Renew for Today would do ─────────────────────────────────────
  // The end of the store's day (or of the planned sale date), from Postgres so
  // it is the same moment the renew writes, and the store's today. Offered
  // when it is later than the expiry the session already has, or when the
  // sale date or a set planned sale date is before today at the store, since
  // Renew is what moves them (_shared/sale-date.ts, renewOffered).
  const renewTo = new Map<string, { renew_to: string; time_zone: string; store_today: string }>();
  // The sale date as it stands, a staff date where there is one. Read here
  // and used only for that: staff_edits can hold names and addresses, and the
  // list never returns it.
  const saleDate = new Map<string, string | null>();
  if (sessionIds.length > 0) {
    const [{ data: targets, error: targetErr }, { data: dates, error: datesErr }] = await Promise.all([
      supabase.schema("fni").rpc("session_renew_targets", { p_ids: sessionIds }),
      supabase.schema("fni").from("sessions").select("id, sale_date, staff_edits").in("id", sessionIds),
    ]);
    if (targetErr) console.error(`session_renew_targets failed: ${targetErr.message}`);
    if (datesErr) console.error(`sale dates for Renew for Today failed: ${datesErr.message}`);
    for (const t of (targets ?? []) as { session_id: string; renew_to: string; time_zone: string; store_today: string }[]) {
      renewTo.set(t.session_id, { renew_to: t.renew_to, time_zone: t.time_zone, store_today: t.store_today });
    }
    for (const d of (dates ?? []) as Record<string, unknown>[]) {
      const sale = applyStaffEdits(d, parseStaffEdits(d.staff_edits)).sale_date;
      saleDate.set(String(d.id), typeof sale === "string" ? sale : null);
    }
  }

  const now = Date.now();
  const renewable = (s: Record<string, unknown>): boolean => {
    const t = renewTo.get(String(s.id));
    if (!t) return false;
    return renewOffered({
      expiresAt: typeof s.expires_at === "string" ? s.expires_at : null,
      renewTo: t.renew_to,
      sale: saleDate.get(String(s.id)) ?? null,
      planned: typeof s.planned_sale_date === "string" ? s.planned_sale_date : null,
      today: t.store_today,
    });
  };

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
      planned_sale_date: s.planned_sale_date ?? null,
      // Renew for Today is offered when it would give the session longer, or
      // move a past sale date or planned sale date to today.
      renewable: renewable(s),
      renew_to: renewTo.get(String(s.id))?.renew_to ?? null,
      time_zone: renewTo.get(String(s.id))?.time_zone ?? null,

      // No row means nobody has asked the provider yet. That is a real and
      // common state on a session created moments ago, so it is named rather
      // than folded into one of the outcomes.
      rating: rating.get(String(s.id)) ?? { state: "Pending", detail: null, at: null, failures: [] },
    })),
  });
}

async function renew(req: Request): Promise<Response> {
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

  const supabase = admin();

  const { data: row, error: readErr } = await supabase
    .schema("fni")
    .from("sessions")
    .select("id,expires_at,store_id,sale_date,planned_sale_date,staff_edits,verification_state")
    .eq("id", sessionId)
    .maybeSingle();

  if (readErr) return json(500, { error: readErr.message });
  if (!row) return json(404, { error: "Session not found" });

  const s = row as Record<string, unknown>;
  const before = s.expires_at as string;
  const who = renewedBy(body.renewed_by);

  // ── Past dates move to today, at the store ────────────────────────────
  const { data: storeRow } = await supabase
    .from("stores")
    .select("time_zone")
    .eq("id", s.store_id as string)
    .maybeSingle();
  const today = storeToday((storeRow as { time_zone?: string } | null)?.time_zone ?? null);
  const edits = parseStaffEdits(s.staff_edits);
  const moves = renewDateMoves({
    // The sale date as it stands: a staff date where there is one.
    sale: (applyStaffEdits(s, edits).sale_date as string | null) ?? null,
    planned: (s.planned_sale_date as string | null) ?? null,
    today,
  });

  if (moves.length > 0) {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {};
    for (const m of moves) {
      if (m.field === "planned_sale_date") patch.planned_sale_date = m.to;
      // A staff edit over the CRM's date, so Refresh from CRM keeps it.
      else patch.staff_edits = { ...edits, sale_date: movedSaleDateEdit(s.sale_date, m.to, who, now) };
    }
    const saleMoved = moves.some((m) => m.field === "sale_date");
    // The sale date is a rating input: a verified deal is verified again.
    if (saleMoved && s.verification_state === "Verified") {
      Object.assign(patch, {
        verification_state: "Needs Verification",
        verified_at: null,
        verified_by: null,
        verified_snapshot: null,
      });
    }

    const { error: moveErr } = await supabase
      .schema("fni")
      .from("sessions")
      .update(patch)
      .eq("id", sessionId);
    if (moveErr) return json(500, { error: moveErr.message });

    // Rated on the old date, so out of date. Kept, never deleted, and no
    // price on them is changed.
    if (saleMoved) {
      const { error: staleErr } = await supabase
        .schema("fni")
        .from("rated_offers")
        .update({ out_of_date: true })
        .eq("session_id", sessionId);
      if (staleErr) return json(500, { error: staleErr.message });
    }

    const { error: eventErr } = await supabase
      .schema("fni")
      .from("session_events")
      .insert(moves.map((m) => ({
        session_id: sessionId,
        event: dateMoveEvent(m, who),
        detail: { field: m.field, from: m.from, to: m.to, store_today: today },
        created_by: who,
      })));
    if (eventErr) console.error(`fni-admin-sessions date move event not recorded for ${sessionId}: ${eventErr.message}`);
  }
  // ── Then the expiry, only if that gives the session longer ────────────
  // Worked out after the moves, since a planned sale date moved to today
  // changes the day it lasts to. A session already open to tonight keeps its
  // open-until time: pressing Renew again moves dates and nothing else.
  const { data: target, error: targetErr } = await supabase
    .schema("fni")
    .rpc("session_renew_targets", { p_ids: [sessionId] });
  if (targetErr) return json(500, { error: targetErr.message });
  const renewTo = ((target ?? []) as { renew_to: string }[])[0]?.renew_to ?? null;
  const extended = renewExtends(before, renewTo);

  let next: string = before;
  if (extended) {
    const { data: renewed, error: writeErr } = await supabase
      .schema("fni")
      .rpc("renew_session", { p_session: sessionId });
    if (writeErr) return json(500, { error: writeErr.message });
    next = renewed as string;
    console.log(`fni-admin-sessions renewed ${sessionId} to ${next}`);
  } else {
    console.log(`fni-admin-sessions ${sessionId} already open to ${before}; ${moves.length} date(s) moved`);
  }

  const current = Date.parse(before);
  return json(200, {
    session_id: sessionId,
    previous_expires_at: before,
    expires_at: next,
    // Whether the open-until time changed. False when it already ran to tonight.
    extended,
    // It was revived rather than merely pushed out. The console says so.
    revived: extended && Number.isFinite(current) && current <= Date.now(),
    // Each date moved to today, in the words of its session event.
    moved: moves.map((m) => dateMoveEvent(m, who)),
  });
}

serve(async (req: Request) => {
  const url = new URL(req.url);

  if (!authorized(req, url)) return json(401, { error: "Unauthorized" });

  try {
    if (req.method === "GET") return await list(url);
    if (req.method === "POST") return await renew(req);
    return json(405, { error: "GET or POST only" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-admin-sessions error:", message);
    return json(500, { error: message });
  }
});
