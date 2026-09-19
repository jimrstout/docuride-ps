// fni-session-get/index.ts
//
// Returns everything the Ownership Planner needs to render, in one call.
//
// There were six fni Edge Functions and none of them read a session back out.
// fni-session-start creates the row and hands Zoho a URL; the browser then opens
// that URL and needs the vehicle, the buyer, the financials, the rated offers
// and the product copy. This is what returns them.
//
// Input (GET):
//   ?session_id=<uuid>
//
// Auth: FNI_WEBHOOK_SECRET via x-webhook-secret header or ?secret= query param.
//
// Behaviour notes:
//   - 410 Gone once expires_at has passed.
//   - 404, never 403, for an unknown session, so the endpoint cannot be used to
//     confirm that a given UUID exists.
//   - raw_snapshot is NEVER returned. It is the full Zoho record and may carry
//     SSN, DOB, driver licence and credit score. Buyer address, phone and email
//     are not returned either -- the planner does not need them, and the less
//     PII crosses the wire the smaller the blast radius of a leaked link.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { normalizeOffer, NormalizedProduct } from "../_shared/planner-offers.ts";
import { priceProduct, PricingRule } from "../_shared/planner-pricing.ts";
import { selectRate } from "../_shared/money.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // A session link must never leak in a referrer to a third party.
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

/** Strip "13,930.94" to 13930.94. Zoho sends TILA values as display strings. */
function zohoNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[$,\s%]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Recover the three payment-math values from the Zoho snapshot when the columns
 * are null, and write them back.
 *
 * Sessions created before migration 0006 have them null. Rather than requiring
 * a change to the working fni-session-start, the session heals itself the first
 * time it is loaded -- raw_snapshot already holds everything needed.
 *
 * See SPEC_CORRECTIONS.md §1 for why these three and not the obvious columns.
 */
function derivePaymentBasis(
  session: Record<string, unknown>
): { interest_rate: number | null; tila_amount_financed: number | null; finance_term_total: number | null } | null {
  const snap = session.raw_snapshot as Record<string, unknown> | null;
  if (!snap) return null;

  const pmt1 = zohoNumber(snap.TILA_Pmt1_Count);
  const pmt2 = zohoNumber(snap.TILA_Pmt2_Count) ?? 0;

  return {
    interest_rate: zohoNumber(snap.Interest_Rate),
    tila_amount_financed: zohoNumber(snap.TILA_Amount_Financed),
    finance_term_total:
      zohoNumber(snap.Term_Months) ?? (pmt1 !== null ? Math.round(pmt1 + pmt2) : null),
  };
}

serve(async (req: Request) => {
  if (req.method !== "GET") return json(405, { error: "GET only" });

  const url = new URL(req.url);

  const presented =
    req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  const configured = Deno.env.get("FNI_WEBHOOK_SECRET");
  if (!secretsMatch(presented, configured)) {
    return json(401, { error: "Unauthorized" });
  }

  const sessionId = url.searchParams.get("session_id");
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return json(400, { error: "A well-formed session_id is required" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // ── Session ────────────────────────────────────────────────────────
    const { data: session, error: sessErr } = await supabase
      .schema("fni")
      .from("sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle();

    // 404 rather than 403, deliberately: a distinguishable "exists but denied"
    // turns this into an oracle for guessing session IDs.
    if (sessErr || !session) {
      return json(404, { error: "Session not found" });
    }

    const s = session as Record<string, unknown>;

    if (s.expires_at && new Date(s.expires_at as string) <= new Date()) {
      return json(410, {
        error: "This planning session has expired",
        expired_at: s.expires_at,
        remedy: "A staff member can start a new session from the deal in one click.",
      });
    }

    // ── Heal missing payment basis ─────────────────────────────────────
    if (
      s.tila_amount_financed === null ||
      s.finance_term_total === null ||
      s.interest_rate === null
    ) {
      const derived = derivePaymentBasis(s);
      if (derived) {
        const patch: Record<string, unknown> = {};
        if (s.interest_rate === null && derived.interest_rate !== null)
          patch.interest_rate = derived.interest_rate;
        if (s.tila_amount_financed === null && derived.tila_amount_financed !== null)
          patch.tila_amount_financed = derived.tila_amount_financed;
        if (s.finance_term_total === null && derived.finance_term_total !== null)
          patch.finance_term_total = derived.finance_term_total;

        if (Object.keys(patch).length > 0) {
          Object.assign(s, patch);
          await supabase
            .schema("fni")
            .from("sessions")
            .update(patch)
            .eq("id", sessionId);
        }
      }
    }

    // ── Rated offer (one row per session, not many) ─────────────────────
    const { data: offerRow } = await supabase
      .schema("fni")
      .from("rated_offers")
      .select("*")
      .eq("session_id", sessionId)
      .maybeSingle();

    const products: NormalizedProduct[] = offerRow
      ? normalizeOffer((offerRow as Record<string, unknown>).response_payload)
      : [];

    // ── Pricing rules, then price each offered product ──────────────────
    const { data: ruleRows } = await supabase
      .schema("fni")
      .from("pricing_rules")
      .select("*")
      .eq("tenant_id", s.tenant_id as string)
      .or(`store_id.eq.${s.store_id},store_id.is.null`)
      .eq("active", true);

    const rules = (ruleRows ?? []) as unknown as PricingRule[];

    const pricedProducts = products.map((p) => {
      const priced = priceProduct(rules, p.product_code, p.dealer_cost);
      return {
        ...p,
        retail_price: priced.unpriced_reason ? null : priced.retail_price,
        pricing_rule_id: priced.rule_id,
        unpriced_reason: priced.unpriced_reason,
      };
    });

    // ── Product copy ────────────────────────────────────────────────────
    // Store copy overrides tenant-wide copy for the same product code.
    const codes = pricedProducts.map((p) => p.product_code).filter((c) => c !== "");

    let catalog: Record<string, unknown>[] = [];
    if (codes.length > 0) {
      const { data: catRows } = await supabase
        .schema("fni")
        .from("product_catalog_presentable")
        .select("*")
        .eq("tenant_id", s.tenant_id as string)
        .in("product_code", codes)
        .or(`store_id.eq.${s.store_id},store_id.is.null`);

      const byCode = new Map<string, Record<string, unknown>>();
      for (const row of (catRows ?? []) as Record<string, unknown>[]) {
        const code = row.product_code as string;
        const existing = byCode.get(code);
        // A store row beats a tenant-wide row.
        if (!existing || (existing.store_id === null && row.store_id !== null)) {
          byCode.set(code, row);
        }
      }
      catalog = [...byCode.values()];
    }

    // ── Selections so far ───────────────────────────────────────────────
    const { data: selections } = await supabase
      .schema("fni")
      .from("selected_products")
      .select("*")
      .eq("session_id", sessionId);

    // ── Rate basis ──────────────────────────────────────────────────────
    const rate = selectRate(
      s.apr as number | null,
      s.interest_rate as number | null
    );

    // ── Shape the response ──────────────────────────────────────────────
    // Field names here follow the build spec's vocabulary; the renaming from
    // the actual column names happens right here so the UI never has to know
    // about unit_year / vehicle_type_code / finance_term_total.
    return json(200, {
      session: {
        id: s.id,
        status: s.status,
        mode: s.mode,
        store_id: s.store_id,
        deal_id: s.deal_id,
        deal_number: s.deal_number,

        buyer_type: s.buyer_type,
        buyer_display_name: s.buyer_display_name,
        cobuyer_type: s.cobuyer_type,
        cobuyer_display_name: s.cobuyer_display_name,

        vehicle: {
          year: s.unit_year,
          make: s.unit_make,
          model: s.unit_model,
          submodel: s.unit_submodel,
          vin: s.vin,
          condition: s.condition,
          tecassured_code: s.vehicle_type_code,
          in_service_date: s.in_service_date,
          mileage_or_hours: s.odometer,
          stock_number: s.stock_number,
        },

        financials: {
          sale_price: s.sale_price,
          // The balance due on the unit. NOT the amortization principal.
          amount_financed: s.amount_financed,
          // The lender's principal. This is what the payment is computed from.
          amortized_principal: s.tila_amount_financed,
          interest_rate: s.interest_rate,
          apr: s.apr,
          rate_used: rate?.ratePercent ?? null,
          rate_source: rate?.source ?? null,
          rate_label: rate?.label ?? null,
          // finance_term is TILA_Pmt1_Count and is not the term; see §1b.
          term_months: s.finance_term_total,
          contract_payment: s.payment,
          finance_type: s.finance_type,
          lienholder_name: s.lienholder_name,
        },

        discovery: s.discovery,
        expires_at: s.expires_at,
      },

      // One object, or null. rated_offers is unique on session_id.
      offer: offerRow
        ? {
            rated_at: (offerRow as Record<string, unknown>).rated_at,
            product_count: (offerRow as Record<string, unknown>).product_count,
            products: pricedProducts,
          }
        : null,

      catalog,
      selections: selections ?? [],
      photos: s.dx1_photos ?? null,
      photos_cached_at: s.dx1_photos_cached_at ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-session-get error:", message);
    return json(500, { error: message });
  }
});
