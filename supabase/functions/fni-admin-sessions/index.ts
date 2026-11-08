// fni-admin-sessions/index.ts
//
// The internal session browser's data source: the most recent planner sessions.
//
// Input:
//   GET  ?limit=25          -> the newest sessions in the stores the signed-in
//                              person may see, by store, then newest first,
//                              with those stores (by full name) and their role
//   GET  ?section=me        -> their role and stores only (the admin menu)
//   GET  ?section=staff     -> Administration > Staff: every sign-in, its PS
//                              role and stores, and every store. Administrators only.
//   POST { section: "staff", action: "set_role" | "set_stores", ... }
//                           -> change one person's role or stores. Administrators only.
//   POST             -> 410. Renew for Today is retired (2026-10-30): a session
//                       is open through 23:59:59 on its CRM sale date at the
//                       store (migration 0044), and the sale date is changed in
//                       the CRM only (_shared/crm-sale-date.ts).
//
// Auth: FNI_WEBHOOK_SECRET via x-webhook-secret header or ?secret= query param,
// exactly as fni-session-get. The browser never holds it; the console's server
// layer does, and the console's own sign-in gates who reaches that layer.
//
// ── Who sees what (migration 0058, _shared/ps-access.ts) ─────────────────
// An Administrator sees every store; Staff only the stores granted to them on
// Administration > Staff, and none when none are granted. The list is read
// with that filter, so a session from any other store is never sent.
//
// ── What the list deliberately does not return ──────────────────────────
// The buyer's and co-buyer's names are returned (8 Nov 2026: the Customer
// column), as the CRM display name the session holds: a company's display
// name for a company. Every other buyer_* and cobuyer_* column, lienholder_*,
// vin and raw_snapshot are withheld. The console cannot leak what it is never
// sent, so the filtering happens here rather than in the page that renders it.
//
// Stock number is included and VIN is not: it identifies the unit on the lot,
// which is what someone browsing for a test session is actually matching on,
// and it is not attached to a person.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { presentedSecret } from "../_shared/presented-secret.ts";
import { psCheck, type PsGateOk } from "../_shared/staff-gate.ts";
import { byStoreThenRecent, isPsRole, NO_STORES_MESSAGE, storeFullName, type PsAccess } from "../_shared/ps-access.ts";
import { currentRows, ratingSummary, type RatingFailure, type RatingRow } from "../_shared/rating-summary.ts";
import { psStores } from "../_shared/ps-stores.ts";

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
  // The Customer column: the CRM display names, nothing else of theirs.
  "buyer_display_name",
  "cobuyer_display_name",
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
    presentedSecret(req);
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

type StoreRow = { id: string; name: string; zoho_store_location: string | null };

/** The stores turned on for DocuRide PS (fni.ps_stores, migration 0059). */
async function storesUsingPs(supabase: ReturnType<typeof admin>): Promise<Set<string>> {
  const settings = await psStores(supabase);
  return new Set([...settings.values()].filter((s) => s.uses_ps).map((s) => s.store_id));
}

/**
 * The person's access cut to the stores that use PS: an Administrator still
 * sees every session (null), Staff only their stores that are turned on.
 */
function effectiveAccess(access: PsAccess, on: Set<string>): PsAccess {
  return access.storeIds === null ? access : { ...access, storeIds: access.storeIds.filter((id) => on.has(id)) };
}

/** The stores the person may choose, by full name, alphabetical: only those that use PS. */
async function permittedStores(supabase: ReturnType<typeof admin>, access: PsAccess, on: Set<string>): Promise<StoreRow[]> {
  const ids = access.storeIds === null ? [...on] : access.storeIds.filter((id) => on.has(id));
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from("stores").select("id,name,zoho_store_location").in("id", ids);
  if (error) throw new Error(`stores: ${error.message}`);
  return ((data ?? []) as StoreRow[]).sort((a, b) => storeFullName(a).localeCompare(storeFullName(b)));
}

async function me(gate: PsGateOk): Promise<Response> {
  const supabase = admin();
  const stores = await permittedStores(supabase, gate.access, await storesUsingPs(supabase));
  return json(200, {
    role: gate.access.role,
    email: gate.staff.email,
    stores: stores.map((s) => ({ id: s.id, name: storeFullName(s) })),
  });
}

async function list(url: URL, gate: PsGateOk): Promise<Response> {
  const asked = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(asked)
    ? Math.min(Math.max(Math.trunc(asked), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const supabase = admin();
  const on = await storesUsingPs(supabase);
  // Staff see only their stores that use PS; an Administrator every session,
  // a store turned off included, since its sessions stay as they were.
  const access = effectiveAccess(gate.access, on);
  const permitted = await permittedStores(supabase, access, on);
  const storeList = permitted.map((s) => ({ id: s.id, name: storeFullName(s) }));

  // Staff with no stores: nothing is read, and they are told why.
  if (access.storeIds !== null && access.storeIds.length === 0) {
    return json(200, { limit, as_of: new Date().toISOString(), role: access.role, stores: [], notice: NO_STORES_MESSAGE, sessions: [] });
  }

  // Only the stores they may see: filtered here, so no other store's session
  // is ever read for them, let alone sent.
  let query = supabase
    .schema("fni")
    .from("sessions")
    .select(LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (access.storeIds !== null) query = query.in("store_id", access.storeIds);
  const { data: rows, error } = await query;

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

  // The full name, as the CRM writes it: public.stores.zoho_store_location
  // ("All Seasons Powersports, Parkersburg"), else the short name.
  const names = new Map<string, string>();
  const zones = new Map<string, string | null>();
  const known = new Map(permitted.map((s) => [s.id, s]));
  const missing = storeIds.filter((id) => !known.has(id));
  if (missing.length > 0) {
    const { data: stores } = await supabase.from("stores").select("id,name,zoho_store_location").in("id", missing);
    for (const s of (stores ?? []) as StoreRow[]) known.set(s.id, s);
  }
  // Each store's time zone is PS's own (fni.ps_stores, migration 0059).
  const settings = await psStores(supabase);
  for (const [id, s] of known) {
    names.set(id, storeFullName(s));
    zones.set(id, settings.get(id)?.time_zone ?? null);
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

  const out = sessions.map((s) => ({
      id: s.id,
      deal_number: s.deal_number,
      status: s.status,
      mode: s.mode,
      store_name: typeof s.store_id === "string" ? names.get(s.store_id) ?? null : null,
      store_id: typeof s.store_id === "string" ? s.store_id : null,
      customer: typeof s.buyer_display_name === "string" && s.buyer_display_name.trim() !== "" ? s.buyer_display_name.trim() : null,
      co_buyer: typeof s.cobuyer_display_name === "string" && s.cobuyer_display_name.trim() !== "" ? s.cobuyer_display_name.trim() : null,
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
    }));

  return json(200, {
    // Echoed so the console can say "the 25 newest" without assuming the
    // number it asked for is the number it got.
    limit,
    as_of: new Date(now).toISOString(),
    role: access.role,
    // The stores they may see, by full name, for the store choice.
    stores: storeList,
    notice: null,
    // By store, then most recent first within each store: the order for
    // "All my stores", and, within one store, most recent first.
    sessions: byStoreThenRecent(out),
  });
}

// ── Administration > Staff ────────────────────────────────────────────────

const ADMINISTRATORS_ONLY = "Only an administrator can change who sees which stores.";

async function staffList(): Promise<Response> {
  const supabase = admin();
  const [{ data: users, error: usersErr }, { data: roles }, { data: grants }, { data: stores }] = await Promise.all([
    supabase.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    supabase.schema("fni").from("staff_roles").select("user_id, role, granted_by, granted_at"),
    supabase.schema("fni").from("staff_store_access").select("user_id, store_id, granted_by, granted_at"),
    supabase.from("stores").select("id,name,zoho_store_location"),
  ]);
  // Only stores that use PS are offered for granting (fni.ps_stores).
  const on = await storesUsingPs(supabase);
  if (usersErr) return json(500, { error: `The sign-ins could not be read: ${usersErr.message}` });
  const roleOf = new Map(((roles ?? []) as { user_id: string; role: string; granted_by: string; granted_at: string }[]).map((r) => [r.user_id, r]));
  const grantsOf = new Map<string, string[]>();
  for (const g of (grants ?? []) as { user_id: string; store_id: string }[]) {
    grantsOf.set(g.user_id, [...(grantsOf.get(g.user_id) ?? []), g.store_id]);
  }
  const people = (users?.users ?? [])
    .map((u) => {
      const r = roleOf.get(u.id);
      return {
        user_id: u.id,
        email: u.email ?? "",
        // In words; no row is no PS role yet.
        role: r && isPsRole(r.role) ? r.role : "No access",
        role_granted_by: r?.granted_by ?? null,
        store_ids: (grantsOf.get(u.id) ?? []).sort(),
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
  return json(200, {
    people,
    stores: ((stores ?? []) as StoreRow[]).filter((s) => on.has(s.id)).map((s) => ({ id: s.id, name: storeFullName(s) })).sort((a, b) => a.name.localeCompare(b.name)),
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function staffWrite(body: Record<string, unknown>, gate: PsGateOk): Promise<Response> {
  if (gate.access.role !== "Administrator") return json(403, { error: ADMINISTRATORS_ONLY });
  const supabase = admin();
  const userId = typeof body.user_id === "string" ? body.user_id : "";
  if (!UUID_RE.test(userId)) return json(400, { error: "Choose a person." });
  const by = gate.staff.email;

  if (body.action === "set_role") {
    const role = body.role;
    // An administrator cannot take their own access away here.
    if (userId === gate.staff.sub) return json(400, { error: "You cannot change your own role. Ask another administrator." });
    if (role === "No access") {
      const { error } = await supabase.schema("fni").from("staff_roles").delete().eq("user_id", userId);
      if (error) return json(500, { error: `The role could not be saved: ${error.message}` });
      return json(200, { ok: true });
    }
    if (!isPsRole(role)) return json(400, { error: "Choose Administrator, Staff or No access." });
    const { error } = await supabase.schema("fni").from("staff_roles").upsert(
      { user_id: userId, role, granted_by: by, granted_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) return json(500, { error: `The role could not be saved: ${error.message}` });
    return json(200, { ok: true });
  }

  if (body.action === "set_stores") {
    const wanted = Array.isArray(body.store_ids) ? [...new Set(body.store_ids.filter((v): v is string => typeof v === "string" && UUID_RE.test(v)))] : null;
    if (!wanted) return json(400, { error: "The stores are missing." });
    const { data: existing, error: readErr } = await supabase.schema("fni").from("staff_store_access").select("store_id").eq("user_id", userId);
    if (readErr) return json(500, { error: `The stores could not be read: ${readErr.message}` });
    const have = new Set(((existing ?? []) as { store_id: string }[]).map((r) => r.store_id));
    const add = wanted.filter((id) => !have.has(id));
    const remove = [...have].filter((id) => !wanted.includes(id));
    if (add.length > 0) {
      const { error } = await supabase.schema("fni").from("staff_store_access").insert(
        add.map((store_id) => ({ user_id: userId, store_id, granted_by: by, granted_at: new Date().toISOString() })),
      );
      if (error) return json(500, { error: `The stores could not be saved: ${error.message}` });
    }
    if (remove.length > 0) {
      const { error } = await supabase.schema("fni").from("staff_store_access").delete().eq("user_id", userId).in("store_id", remove);
      if (error) return json(500, { error: `The stores could not be saved: ${error.message}` });
    }
    return json(200, { ok: true, added: add.length, removed: remove.length });
  }

  return json(400, { error: "action must be set_role or set_stores" });
}

serve(async (req: Request) => {
  const url = new URL(req.url);

  if (!authorized(req, url)) return json(401, { error: "Unauthorized" });
  // The staff sign-in, and the person's PS role and stores (_shared/ps-access.ts).
  const gate = await psCheck(req);
  if ("response" in gate) return gate.response;

  try {
    if (req.method === "GET") {
      const section = url.searchParams.get("section");
      if (section === "me") return await me(gate);
      if (section === "staff") {
        if (gate.access.role !== "Administrator") return json(403, { error: ADMINISTRATORS_ONLY });
        return await staffList();
      }
      return await list(url, gate);
    }
    if (req.method === "POST") {
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
      if (body.section === "staff") return await staffWrite(body, gate);
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
