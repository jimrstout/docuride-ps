// fni-session-save/index.ts
//
// Persists a customer's decisions as they make them, not only at the end.
//
// Two things depend on this. A buyer who closes the tab halfway through can pick
// up where they left off. And the stated goal -- standardizing the presentation
// so that aggressive F&I behaviour becomes difficult -- depends on there being a
// record of what was presented and when. Before this function, no such record
// existed until contract submit.
//
// Input (POST JSON):
//   session_id   - uuid, required
//   decisions    - [{ product_code, disposition, retail_price, dealer_cost,
//                     customer_price, product_name, product_type,
//                     rate_unique_id, term_months, term_miles, deductible,
//                     selected_options, rate_snapshot, presented_at }]
//   discovery    - answers to the ownership questions (optional)
//   mode         - Self-Guided | Collaborative | Staff-Presented (optional)
//   presented_at - ISO timestamp the products were put in front of the customer.
//                  A decision may carry its own presented_at, which wins: the
//                  planner now shows one product per screen, so each was put in
//                  front of the customer at a different moment, and a single
//                  session-level stamp would flatten that. The session-level
//                  value stays as the fallback for older clients.
//   dx1_photos   - cached VIN photo lookup result (optional; written by the
//                  Next.js photo route, which holds the DX1 key)
//   complete     - true when the customer has finished the plan. On a
//                  complete save the additional down payment is worked out
//                  HERE, from the saved Included selections priced from the
//                  stored quote, and written to sessions.additional_down_payment.
//                  No price sent by the browser is used for it.
//
// Auth: FNI_WEBHOOK_SECRET via x-webhook-secret header or ?secret= query param.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { SESSION_MODES, isSessionMode } from "../_shared/session-mode.ts";
import { normalizeOffer } from "../_shared/planner-offers.ts";
import type { PricingRule } from "../_shared/planner-pricing.ts";
import {
  additionalDownForSelections,
  priceFamilies,
  type SavedSelection,
} from "../_shared/plan-prices.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Human-readable, deliberately. These are the strings the customer signs, so
// they are not enum tokens that get translated at the last moment -- and
// "Managed by Customer" is not "Not Selected", which frames the same decision
// as a failure to act.
const DISPOSITIONS = ["Included", "Managed by Customer"] as const;
type Disposition = (typeof DISPOSITIONS)[number];

// fni.sessions.status admits a fixed vocabulary. "In Progress" is not in it and
// would fail the CHECK constraint outright; "Presenting" is the existing term
// for the same state. See SPEC_CORRECTIONS.md §2a.
const STATUS_PRESENTING = "Presenting";
const STATUS_SELECTED = "Products Selected";
const TERMINAL = ["Finalized", "Written Back", "Cancelled"];

// Every column the additional down payment is worked out from: the finance
// figures the planner's principal comes from, the finance company's maximum,
// and the tenant and store the pricing rules belong to.
const SESSION_COLUMNS = [
  "id", "status", "expires_at", "tenant_id", "store_id",
  "tila_amount_financed", "amount_financed", "apr", "interest_rate",
  "finance_term_total", "lienholder_name", "max_amount_financed",
].join(", ");

/**
 * The additional down payment for the saved plan, priced on the server.
 *
 * The Included rows are read back after this save's upsert, so they are the
 * plan as it now stands. Each is priced from the stored quote and the store's
 * pricing rules through _shared/plan-prices.ts, the same pricing the planner is
 * shown. A quote that is out of date prices nothing, and null is written rather
 * than a guess or a browser figure.
 */
async function serverAdditionalDown(
  supabase: ReturnType<typeof createClient>,
  s: Record<string, unknown>
): Promise<{ value: number | null; reason: string | null }> {
  const { data: offerRow } = await supabase
    .schema("fni")
    .from("rated_offers")
    .select("response_payload, out_of_date")
    .eq("session_id", s.id as string)
    .maybeSingle();
  const offer = (offerRow ?? null) as { response_payload: unknown; out_of_date: boolean } | null;

  const { data: ruleRows } = await supabase
    .schema("fni")
    .from("pricing_rules")
    .select("*")
    .eq("tenant_id", s.tenant_id as string)
    .or(`store_id.eq.${s.store_id},store_id.is.null`)
    .eq("active", true);

  const { data: rows, error } = await supabase
    .schema("fni")
    .from("selected_products")
    .select("provider_product_id, rate_unique_id, selected_options")
    .eq("session_id", s.id as string)
    .eq("disposition", "Included");
  if (error) return { value: null, reason: `could not read selections: ${error.message}` };

  const selections = (rows ?? []) as unknown as SavedSelection[];
  const current = offer && offer.out_of_date !== true ? offer.response_payload : null;
  if (selections.length > 0 && current === null) {
    return { value: null, reason: "no current quote to price the selections from" };
  }

  const priced = priceFamilies(
    current === null ? [] : normalizeOffer(current),
    (ruleRows ?? []) as unknown as PricingRule[]
  );
  return additionalDownForSelections(s, priced, selections);
}

interface Decision {
  product_code?: string;
  product_type?: string;
  product_name?: string;
  disposition?: string;
  rate_unique_id?: string | null;
  term_months?: number | null;
  term_miles?: number | null;
  deductible?: number | null;
  dealer_cost?: number | null;
  retail_price?: number | null;
  customer_price?: number | null;
  selected_options?: unknown;
  rate_snapshot?: unknown;
  /** When THIS product was put in front of the customer. Overrides the
      session-level presented_at for this row. */
  presented_at?: string | null;
}

interface SaveRequest {
  session_id?: string;
  decisions?: Decision[];
  discovery?: unknown;
  mode?: string;
  presented_at?: string;
  dx1_photos?: unknown;
  complete?: boolean;
}

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

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

/** A usable ISO timestamp, or the fallback. Never an invalid date. */
function isoOr(v: unknown, fallback: string): string {
  if (typeof v !== "string" || v.trim() === "") return fallback;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = new URL(req.url);

  const presented =
    req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  const configured = Deno.env.get("FNI_WEBHOOK_SECRET");
  if (!secretsMatch(presented, configured)) {
    return json(401, { error: "Unauthorized" });
  }

  let body: SaveRequest;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const sessionId = body.session_id;
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return json(400, { error: "A well-formed session_id is required" });
  }

  if (body.mode !== undefined && !isSessionMode(body.mode)) {
    return json(400, { error: `mode must be one of ${SESSION_MODES.join(", ")}` });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // ── Load and gate the session ───────────────────────────────────────
    const { data: session, error: sessErr } = await supabase
      .schema("fni")
      .from("sessions")
      .select(SESSION_COLUMNS)
      .eq("id", sessionId)
      .maybeSingle();

    if (sessErr || !session) return json(404, { error: "Session not found" });

    const s = session as { id: string; status: string; expires_at: string | null };

    if (s.expires_at && new Date(s.expires_at) <= new Date()) {
      return json(410, { error: "This planning session has expired" });
    }

    if (TERMINAL.includes(s.status)) {
      return json(409, {
        error: `Session is ${s.status} and can no longer be changed`,
      });
    }

    // ── Validate decisions before writing any of them ───────────────────
    const decisions = Array.isArray(body.decisions) ? body.decisions : [];
    const problems: string[] = [];

    decisions.forEach((d, i) => {
      if (!d.product_code || String(d.product_code).trim() === "") {
        problems.push(`decisions[${i}]: product_code is required`);
      }
      if (!DISPOSITIONS.includes(d.disposition as Disposition)) {
        problems.push(
          `decisions[${i}]: disposition must be one of ${DISPOSITIONS.join(" | ")}`
        );
      }
    });

    // Two decisions for the same product in one payload would make the upsert
    // order-dependent, and the customer's real answer ambiguous.
    const codes = decisions.map((d) => String(d.product_code ?? ""));
    const dupes = codes.filter((c, i) => c !== "" && codes.indexOf(c) !== i);
    if (dupes.length > 0) {
      problems.push(`duplicate product_code in one payload: ${[...new Set(dupes)].join(", ")}`);
    }

    if (problems.length > 0) {
      return json(400, { error: "Invalid decisions", problems });
    }

    // ── Upsert the decisions ────────────────────────────────────────────
    // A row is written for declines as well as includes. Without that, a product
    // the customer declined is indistinguishable from one they never reached,
    // and the acknowledgment cannot list what was presented.
    const presentedAt = body.presented_at ?? new Date().toISOString();
    let written = 0;

    if (decisions.length > 0) {
      const rows = decisions.map((d) => {
        const included = d.disposition === "Included";
        return {
          session_id: sessionId,
          provider_product_id: String(d.product_code),
          product_type: d.product_type ?? String(d.product_code),
          product_name: d.product_name ?? String(d.product_code),
          disposition: d.disposition as Disposition,
          rate_unique_id: d.rate_unique_id ?? null,
          term_months: int(d.term_months),
          term_miles: int(d.term_miles),
          deductible: num(d.deductible),
          // A decline carries no price. Storing the price it would have been
          // is tempting but wrong: nothing was sold, and the acknowledgment
          // prints the disposition, not a hypothetical.
          dealer_cost: included ? num(d.dealer_cost) : null,
          retail_price: included ? num(d.retail_price) : null,
          customer_price: included ? num(d.customer_price ?? d.retail_price) : null,
          selected_options: d.selected_options ?? null,
          rate_snapshot: d.rate_snapshot ?? null,
          // Per product where the client knows it, session-level otherwise.
          // Anything unparseable falls back rather than writing a bad stamp.
          presented_at: isoOr(d.presented_at, presentedAt),
          selected_at: new Date().toISOString(),
        };
      });

      const { error: upsertErr } = await supabase
        .schema("fni")
        .from("selected_products")
        .upsert(rows, { onConflict: "session_id,provider_product_id" });

      if (upsertErr) {
        throw new Error(`Failed to save decisions: ${upsertErr.message}`);
      }
      written = rows.length;
    }

    // ── Update the session ──────────────────────────────────────────────
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.discovery !== undefined) patch.discovery = body.discovery;
    if (body.mode !== undefined) patch.mode = body.mode;
    if (body.dx1_photos !== undefined) {
      patch.dx1_photos = body.dx1_photos;
      patch.dx1_photos_cached_at = new Date().toISOString();
    }

    // Advance the status, but never walk it backwards -- a session that has
    // already produced an agreement is not demoted by a late autosave.
    if (body.complete === true) {
      if (s.status === "Initiated" || s.status === "Rated" || s.status === STATUS_PRESENTING) {
        patch.status = STATUS_SELECTED;
      }

      // ── The additional down payment, worked out here ─────────────────────
      // Never from a figure the browser sent. See serverAdditionalDown.
      const down = await serverAdditionalDown(supabase, session as Record<string, unknown>);
      patch.additional_down_payment = down.value;
      if (down.value === null) {
        console.warn(`fni-session-save ${sessionId}: additional down not set (${down.reason})`);
      }
    } else if (s.status === "Initiated" || s.status === "Rated") {
      patch.status = STATUS_PRESENTING;
    }

    const { error: updErr } = await supabase
      .schema("fni")
      .from("sessions")
      .update(patch)
      .eq("id", sessionId);

    if (updErr) throw new Error(`Failed to update session: ${updErr.message}`);

    const { count } = await supabase
      .schema("fni")
      .from("selected_products")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId);

    return json(200, {
      session_id: sessionId,
      status: patch.status ?? s.status,
      decisions_written: written,
      decisions_on_record: count ?? null,
      presented_at: presentedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-session-save error:", message);
    return json(500, { error: message });
  }
});
