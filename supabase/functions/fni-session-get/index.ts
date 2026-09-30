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
import { allTiers, normalizeOffer, NormalizedFamily } from "../_shared/planner-offers.ts";
import { PricingRule } from "../_shared/planner-pricing.ts";
import { priceFamilies, sessionCap, sessionPaymentBasis } from "../_shared/plan-prices.ts";
import { modeLabel } from "../_shared/session-mode.ts";
import {
  CatalogRow,
  classifyCoverage,
  indexCatalog,
  joinFailureReport,
} from "../_shared/planner-catalog.ts";
import {
  type CopyTemplateRow,
  resolveTemplates,
} from "../_shared/copy-templates.ts";

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

/** Postgres numerics arrive as strings over PostgREST. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
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

    const offerRaw = (offerRow ?? null) as Record<string, unknown> | null;

    // ── A superseded quote is not a quote ─────────────────────────────────
    // A refresh that moved a rating input, or a fresh verification, marks the
    // old quote out of date rather than deleting it: it was a real price once
    // and the record of it matters. But it is not the answer to the current
    // question, so nothing downstream may treat it as one -- the customer must
    // not be shown prices built on inputs that have since changed.
    const superseded = offerRaw?.out_of_date === true;
    const offer = superseded ? null : offerRaw;

    const families: NormalizedFamily[] = offer
      ? normalizeOffer(offer.response_payload)
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

    // Priced per rate, in _shared/plan-prices.ts, which fni-session-save also
    // uses to price the saved selections. One pricing, so the page and the
    // save cannot disagree.
    const pricedFamilies = priceFamilies(families, rules);

    // Catalog copy is keyed on the product code, which is the tier.
    const tiers = allTiers(pricedFamilies);

    // ── The dealer group's name, and the copy that uses it ─────────────
    // Both were facts written into code until 0012. The name is what a buyer
    // reads, not tenants.name, which is administrative. A tenant template row
    // overrides the platform default, exactly as store copy overrides
    // tenant-wide copy below.
    const { data: tenantRow } = await supabase
      .from("tenants")
      .select("dealer_group_display_name")
      .eq("id", s.tenant_id as string)
      .maybeSingle();

    const dealerGroupName =
      ((tenantRow as { dealer_group_display_name?: string | null } | null)
        ?.dealer_group_display_name ?? null);

    const { data: templateRows } = await supabase
      .schema("fni")
      .from("copy_templates")
      .select("tenant_id, template_key, body")
      .or(`tenant_id.eq.${s.tenant_id},tenant_id.is.null`);

    const copy = Object.fromEntries(
      resolveTemplates((templateRows ?? []) as unknown as CopyTemplateRow[])
    );

    // ── Product copy ────────────────────────────────────────────────────
    // Store copy overrides tenant-wide copy for the same product code.
    const codes = tiers.map((t) => t.product_code).filter((c) => c !== "");

    let catalog: Record<string, unknown>[] = [];
    let byCode = new Map<string, CatalogRow>();

    if (codes.length > 0) {
      const { data: catRows } = await supabase
        .schema("fni")
        .from("product_catalog_presentable")
        .select("*")
        .eq("tenant_id", s.tenant_id as string)
        .in("product_code", codes)
        .or(`store_id.eq.${s.store_id},store_id.is.null`);

      byCode = indexCatalog((catRows ?? []) as unknown as CatalogRow[]);
      catalog = [...byCode.values()] as unknown as Record<string, unknown>[];
    }

    // Did every rated product find its copy? A product withheld for unwritten
    // copy is a decision; one that matched nothing is a defect. They used to be
    // the same silent absence. See _shared/planner-catalog.ts.
    const coverage = classifyCoverage(
      tiers.map((t) => ({
        product_code: t.product_code,
        product_name: t.product_name,
      })),
      byCode
    );

    if (coverage.unmatched.length > 0) {
      console.error(
        "fni-session-get CATALOG JOIN FAILED:",
        joinFailureReport(
          sessionId,
          (s.store_id as string) ?? null,
          coverage,
          tiers.map((t) => t.product_code)
        )
      );
    }

    // ── Selections so far ───────────────────────────────────────────────
    const { data: selections } = await supabase
      .schema("fni")
      .from("selected_products")
      .select("*")
      .eq("session_id", sessionId);

    // ── Rate basis ──────────────────────────────────────────────────────
    // Where this deal's payment comes from, if it has one. A cash deal -- no
    // lienholder -- has no payment, and the planner must not invent one from
    // whatever the financing columns happen to still hold.
    // Shared with fni-session-save, which measures the additional down payment
    // against this same principal and cap.
    const basis = sessionPaymentBasis(s as Record<string, unknown>);
    const cap = sessionCap(s as Record<string, unknown>, basis);

    // ── Shape the response ──────────────────────────────────────────────
    // Field names here follow the build spec's vocabulary; the renaming from
    // the actual column names happens right here so the UI never has to know
    // about unit_year / vehicle_type_code / finance_term_total.
    return json(200, {
      session: {
        id: s.id,
        status: s.status,
        mode: s.mode,
        // Derived server-side so the browser and the acknowledgment document
        // cannot disagree about what to call the same session.
        mode_label: modeLabel(s.mode as string | null),
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
          // The balance due on the unit. The fallback principal, not the
          // TILA one.
          amount_financed: s.amount_financed,
          // The principal actually used, whichever tier supplied it.
          amortized_principal: basis.principal,
          interest_rate: s.interest_rate,
          apr: s.apr,
          rate_used: basis.ratePercent,
          rate_source: basis.rateSource,
          rate_label: basis.rateLabel,
          // finance_term is TILA_Pmt1_Count and is not the term; see §1b.
          term_months: basis.termMonths,
          contract_payment: s.payment,
          finance_type: s.finance_type,
          lienholder_name: s.lienholder_name,
          // tila | lienholder | cash | unavailable. `cash` is a deal with no
          // lienholder: it has no payment, and every monthly figure in the
          // interface is gated on has_payment because of it.
          payment_basis: basis.kind,
          has_payment: basis.hasPayment,
          // The finance company's maximum amount financed, and the down payment
          // agreed on the deal. The planner holds what is financed to the
          // maximum and adds anything past it to the money down; it never shows
          // the maximum itself. Null on a cash deal.
          max_amount_financed: cap,
          agreed_down_payment: num(s.agreed_down_payment),
        },

        discovery: s.discovery,
        expires_at: s.expires_at,
      },

      // ── Why there is no menu, when there is no menu ──────────────────
      // Four states, because the customer must only ever be told that plans
      // are not offered when that is actually what the provider said.
      //
      //   Rated        There is a menu.
      //   Not Offered  A request the provider accepted came back with nothing.
      //                The only state that earns "not offered on this machine".
      //   Failed       We asked and it did not work. Neutral copy, and `detail`
      //                says why, for staff.
      //   Pending      Nobody has asked yet. Also neutral copy: on a session
      //                created seconds ago this is the normal state, not a
      //                fault, and it is what deal 14132 was in while the
      //                customer read that plans were not offered.
      //   Superseded   A quote exists and its inputs have since moved. Neutral
      //                copy, like Pending: there is nothing current to show and
      //                the machine is not the reason.
      //
      // `detail` is written for a staff member and must not be rendered to a
      // customer. The planner's server layer logs it and drops it.
      offer_status: {
        state: superseded ? "Superseded" : offer ? String(offer.state ?? "Rated") : "Pending",
        detail: offer && offer.state === "Failed"
          ? ((offer.error_detail as string | null) ?? null)
          : null,
        attempted_at: offerRaw ? offerRaw.rated_at : null,
      },

      // ── Has a person checked the inputs? ────────────────────────────────
      // The planner asks for its own rate, and must not do so on a deal nobody
      // has looked at: two of the fields TecAssured wants for a UTV have no
      // source in the CRM, so an unattended request is one built partly on
      // defaults. Staff-facing detail is deliberately absent -- the customer's
      // browser gets the state and nothing else.
      verification: {
        state: String(s.verification_state ?? "Needs Verification"),
        verified_at: s.verified_at ?? null,
      },

      // One object, or null. rated_offers is unique on session_id.
      offer: offer
        ? {
            rated_at: offer.rated_at,
            product_count: offer.product_count,
            // Families, each with tiers, each tier with its rates. One decision
            // per family rather than one per product: Platinum, Gold, Silver and
            // Bronze are tiers of the same thing, and asking a customer to
            // include or decline each of them separately invites a combination
            // that makes no sense.
            families: pricedFamilies,
          }
        : null,

      catalog,

      // The dealer group as a customer should read it. Null means no name has
      // been entered, and any sentence naming the group is omitted rather than
      // rendered with a gap in it.
      dealer_group_name: dealerGroupName,

      // Customer-facing sentences with {placeholder} names still in them. The
      // planner fills them, because only the planner knows which rate the
      // customer chose and therefore what the amount is.
      copy,

      // Whether each rated product found its copy. The UI needs the two
      // failures apart: one is a decision, the other is a defect.
      catalog_coverage: coverage,

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
