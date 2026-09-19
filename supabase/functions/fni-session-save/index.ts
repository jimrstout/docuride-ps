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
//                     selected_options, rate_snapshot }]
//   discovery    - answers to the ownership questions (optional)
//   mode         - self-guided | collaborative | staff-presented (optional)
//   presented_at - ISO timestamp the products were put in front of the customer
//   dx1_photos   - cached VIN photo lookup result (optional; written by the
//                  Next.js photo route, which holds the DX1 key)
//   complete     - true when the customer has finished the plan
//
// Auth: FNI_WEBHOOK_SECRET via x-webhook-secret header or ?secret= query param.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Human-readable, deliberately. These are the strings the customer signs, so
// they are not enum tokens that get translated at the last moment -- and
// "Managed by Customer" is not "Not Selected", which frames the same decision
// as a failure to act.
const DISPOSITIONS = ["Included", "Managed by Customer"] as const;
type Disposition = (typeof DISPOSITIONS)[number];

const MODES = ["self-guided", "collaborative", "staff-presented"] as const;

// fni.sessions.status admits a fixed vocabulary. "In Progress" is not in it and
// would fail the CHECK constraint outright; "Presenting" is the existing term
// for the same state. See SPEC_CORRECTIONS.md §2a.
const STATUS_PRESENTING = "Presenting";
const STATUS_SELECTED = "Products Selected";
const TERMINAL = ["Finalized", "Written Back", "Cancelled"];

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

  if (body.mode !== undefined && !MODES.includes(body.mode as typeof MODES[number])) {
    return json(400, { error: `mode must be one of ${MODES.join(", ")}` });
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
      .select("id, status, expires_at")
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
          presented_at: presentedAt,
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
