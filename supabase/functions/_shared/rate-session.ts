// _shared/rate-session.ts
//
// Rating a session across providers. See docs/multi-provider.md, section 5.
//
//   1. Match the menu template for the deal.
//   2. Collect the providers its slots need.
//   3. Rate each through its adapter, in parallel.
//   4. Write one fni.rated_offers row per provider. A provider that fails gets a
//      Failed row and does not stop the others.
//
// The session records the template and the providers this rating covered, so
// the menu and Verify read exactly this rating and not a provider an earlier
// one needed.

import { resolveVehicleType } from "./vehicle-types.ts";
import { programNamesFromQuote } from "./program-names.ts";
import { keepsPrior, keptStillCurrent, keptWarning, type PriorOffer } from "./rerate.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createTecAssuredClient } from "./tecassured.ts";
import { tecAssuredAdapter, type TecAssuredDetail } from "./adapters/tecassured.ts";
import { rateFromSheet } from "./adapters/price-sheet.ts";
import { publishedSheetFor } from "./price-sheet-rows.ts";
import type { RateResult, RatingDeal } from "./adapters/types.ts";
import { chooseTemplate, type MenuTemplate } from "./menu-templates.ts";
import { slotCatalog, templatesFor } from "./menu-template-rows.ts";
import { groupOffers } from "./normalized-offer.ts";
import { resolveEngineCc } from "./engine-size.ts";

export interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  adapter: string | null;
  active: boolean;
}

export interface ProviderOutcome {
  provider: ProviderRow;
  result: RateResult;
  /** Tiers offered: what product_count has always counted. */
  productCount: number;
  /** Set when TecAssured was called. */
  tecassured?: TecAssuredDetail & { credentialId: string; environment: string };
  /**
   * Set when this attempt failed and the last good offers were kept. current
   * says whether they still answer for this deal (see _shared/rerate.ts).
   */
  kept?: { product_count: number; current: boolean; warning: string };
}

/** The deal as rating and template matching see it, staff edits applied. */
export function ratingDeal(src: Record<string, unknown>): RatingDeal & { deal_type: string | null } {
  const num = (v: unknown) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());
  return {
    store_id: src.store_id as string,
    make: str(src.unit_make),
    model: str(src.unit_model),
    year: num(src.unit_year),
    condition: str(src.condition),
    vehicle_type_code: str(src.vehicle_type_code),
    vehicle_type: resolveVehicleType(src).type,
    odometer: num(src.odometer),
    // The rate request's own resolution: staff entry first, then the VIN decode.
    engine_cc: num(resolveEngineCc(src.vehicle_properties, src.vin_decode)?.value ?? null),
    sale_date: str(src.sale_date),
    in_service_date: str(src.in_service_date),
    deal_type: str(src.finance_type),
  };
}

/** The tenant's active providers. */
async function providersFor(supabase: SupabaseClient, tenantId: string): Promise<ProviderRow[]> {
  const { data, error } = await supabase
    .schema("fni")
    .from("providers")
    .select("id, name, kind, adapter, active")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  if (error) throw new Error(`Failed to read the providers: ${error.message}`);
  return (data ?? []) as unknown as ProviderRow[];
}

/**
 * The template for the deal and the providers it needs.
 *
 * With no template at all (a tenant set up before Part 3, or every template
 * switched off) the TecAssured provider alone is rated, which is how rating
 * always worked.
 */
export async function menuFor(
  supabase: SupabaseClient,
  tenantId: string,
  deal: RatingDeal & { deal_type: string | null }
): Promise<{ template: MenuTemplate | null; providers: ProviderRow[] }> {
  const [all, { templates, slots }] = await Promise.all([
    providersFor(supabase, tenantId),
    templatesFor(supabase, tenantId),
  ]);
  const template = chooseTemplate(templates, {
    store_id: deal.store_id,
    deal_type: deal.deal_type,
    vehicle_type: deal.vehicle_type ?? null,
    condition: deal.condition,
    make: deal.make,
  });

  if (!template) {
    return { template: null, providers: all.filter((p) => p.adapter === "TecAssured") };
  }
  const ids = slots.filter((s) => s.template_id === template.id).flatMap((s) => s.product_ids);
  const catalog = await slotCatalog(supabase, ids);
  const needed = new Set([...catalog.values()].map((p) => p.provider_id));
  return { template, providers: all.filter((p) => needed.has(p.id)) };
}

/** Rate one provider. Never throws: a failure is a Failed outcome. */
async function rateOne(
  supabase: SupabaseClient,
  provider: ProviderRow,
  storeId: string,
  rateSource: Record<string, unknown>,
  deal: RatingDeal
): Promise<ProviderOutcome> {
  const offerProvider = { id: provider.id, name: provider.name };
  try {
    if (provider.adapter === "TecAssured") {
      let store;
      try {
        store = await createTecAssuredClient(storeId, supabase);
      } catch (err) {
        return {
          provider,
          productCount: 0,
          result: { state: "Failed", reason: err instanceof Error ? err.message : String(err) },
        };
      }
      const adapter = tecAssuredAdapter(supabase, store, offerProvider, rateSource);
      const result = await adapter.rate();
      return {
        provider,
        result,
        productCount: result.state === "Rated" ? countTiers(result) : 0,
        tecassured: {
          ...adapter.detail,
          credentialId: store.credentials.id,
          environment: store.credentials.environment,
        },
      };
    }

    if (provider.kind === "Price Sheet") {
      const { sheet, rates } = await publishedSheetFor(supabase, provider.id, deal.sale_date);
      const result = rateFromSheet(offerProvider, sheet, rates, deal);
      return { provider, result, productCount: result.state === "Rated" ? countTiers(result) : 0 };
    }

    return {
      provider,
      productCount: 0,
      result: { state: "Failed", reason: `${provider.name} has no adapter to rate with.` },
    };
  } catch (err) {
    return {
      provider,
      productCount: 0,
      result: {
        state: "Failed",
        reason: `Rating failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

function countTiers(result: RateResult): number {
  if (result.state !== "Rated") return 0;
  return groupOffers(result.offers).reduce((n, f) => n + f.tiers.length, 0);
}

/**
 * What to store as the row's response. TecAssured keeps its own quote, read
 * back the way it always was. Any other provider stores its offers: a snapshot
 * of the sheet as rated.
 */
function responseFor(o: ProviderOutcome): unknown {
  if (o.provider.adapter === "TecAssured") return o.result.response ?? null;
  if (o.result.state === "Rated") return { offers: o.result.offers, ...(o.result.response as object) };
  return o.result.response ?? null;
}

/**
 * Record one attempt. A failure to record is logged, never thrown.
 *
 * A failed attempt never replaces offers the provider gave earlier: the Rated
 * row is kept and the failure goes beside it as a warning. Returns what was
 * kept, or null when the attempt was recorded as it came.
 */
export async function recordOutcome(
  supabase: SupabaseClient,
  sessionId: string,
  o: ProviderOutcome
): Promise<ProviderOutcome["kept"] | null> {
  if (o.result.state === "Failed") {
    const reason = o.result.reason;
    const { data: priorRow } = await supabase
      .schema("fni")
      .from("rated_offers")
      .select("state, out_of_date, request_payload, product_count, rated_at")
      .eq("session_id", sessionId)
      .eq("provider_id", o.provider.id)
      .maybeSingle();
    const prior = (priorRow as PriorOffer | null) ?? null;
    if (keepsPrior(prior)) {
      const current = keptStillCurrent(prior, o.result.request ?? null);
      const { error } = await supabase
        .schema("fni")
        .from("rated_offers")
        .update({
          last_failure_detail: reason,
          last_failure_at: new Date().toISOString(),
          // Current or not, by what the failed attempt shows about the deal.
          out_of_date: !current,
        })
        .eq("session_id", sessionId)
        .eq("provider_id", o.provider.id);
      if (error) {
        console.error(
          `RATE_ATTEMPT_NOT_RECORDED session=${sessionId} provider=${o.provider.name} ` +
            `state=Failed (kept): ${error.message}`
        );
      }
      return { product_count: prior.product_count, current, warning: keptWarning(o.provider.name, reason, current) };
    }
  }

  const { error } = await supabase
    .schema("fni")
    .from("rated_offers")
    .upsert(
      {
        session_id: sessionId,
        provider_id: o.provider.id,
        state: o.result.state,
        request_payload: o.result.request ?? null,
        response_payload: responseFor(o),
        product_count: o.productCount,
        // 0013: a reason for Failed, and none otherwise.
        error_detail: o.result.state === "Failed" ? o.result.reason : null,
        rated_at: new Date().toISOString(),
        // Every attempt rates the session's current values, so it is current.
        out_of_date: false,
        // An answer from the provider clears the warning of a failed re-rate.
        last_failure_detail: null,
        last_failure_at: null,
      },
      { onConflict: "session_id,provider_id" }
    );
  if (error) {
    console.error(
      `RATE_ATTEMPT_NOT_RECORDED session=${sessionId} provider=${o.provider.name} ` +
        `state=${o.result.state}: ${error.message}`
    );
  }
  return null;
}

/** Rate every provider the deal's menu needs, and record each attempt. */
export async function rateSession(
  supabase: SupabaseClient,
  session: { id: string; tenant_id: string; store_id: string },
  rateSource: Record<string, unknown>
): Promise<{ template: MenuTemplate | null; outcomes: ProviderOutcome[] }> {
  const deal = ratingDeal({ ...rateSource, store_id: session.store_id });
  const { template, providers } = await menuFor(supabase, session.tenant_id, deal);

  const outcomes = await Promise.all(
    providers.map((p) => rateOne(supabase, p, session.store_id, rateSource, deal))
  );
  const kept = await Promise.all(outcomes.map((o) => recordOutcome(supabase, session.id, o)));
  kept.forEach((k, i) => {
    if (k) outcomes[i].kept = k;
  });
  await Promise.all(
    outcomes
      .filter((o) => o.provider.adapter === "TecAssured" && o.result.state === "Rated")
      .map((o) => recordProgramNames(supabase, session.tenant_id, o.provider.id, o.result.response))
  );
  return { template, outcomes };
}

/**
 * Keep the catalog's TecAssured program names current, from what TecAssured
 * just quoted, so staff can tell product versions apart in Admin and on
 * Verify. Only a name that changed is written; a failure here is logged and
 * never fails the rating.
 */
async function recordProgramNames(
  supabase: SupabaseClient,
  tenantId: string,
  providerId: string,
  quote: unknown
): Promise<void> {
  const names = programNamesFromQuote(quote);
  if (names.size === 0) return;
  const { data } = await supabase
    .schema("fni")
    .from("product_catalog")
    .select("id, product_code, provider_program_name")
    .eq("tenant_id", tenantId)
    .eq("provider_id", providerId)
    .in("product_code", [...names.keys()]);
  for (const row of (data ?? []) as { id: string; product_code: string; provider_program_name: string | null }[]) {
    const name = names.get(row.product_code);
    if (!name || name === row.provider_program_name) continue;
    const { error } = await supabase.schema("fni").from("product_catalog").update({ provider_program_name: name }).eq("id", row.id);
    if (error) console.error(`PROGRAM_NAME_NOT_RECORDED code=${row.product_code}: ${error.code ?? "error"}`);
  }
}
