// fni-rate-vehicle/index.ts
// Called from the planner's server layer to rate a vehicle through TecAssured
// and get the Offer Format back.
//
// Input (POST JSON):
//   session_id  - fni.sessions UUID (required)
//   overrides   - optional field corrections from the UI
//
// Auth: FNI_WEBHOOK_SECRET via ?secret= query param or x-webhook-secret header
//
// ── The request is built from what the server asks for (2026-09-25) ───
// The rate request is NOT a set of named camelCase fields. TecAssured wants a
// `properties` array whose names come from /rate/requiredproperties for this
// dealer and this vehicle type -- dotted and lowercase: engine.ccs,
// finance.amount, sale.date, postal.code. Sending the camelCase fields makes
// the server ask for displacement even when displacement is supplied; sending
// the dotted names gets past that check.
//
// So this function asks what is needed, then sends BOTH halves: the documented
// top-level fields, and a properties array with one entry per name
// requiredproperties asked for, in its order, spelled its way. Proved against
// the QA server on 2026-09-25 -- 11 products, 41 rates. Sending either half
// alone fails. See _shared/rate-properties.ts for why the two formats are
// near-duplicates of each other.
//
// The spelling in the array matters and has no rule to it: `warranty` for ATV
// and MCYC, `Warranty` for UTV and BIKE, and not asked for at all by BOAT,
// PWAC or SNOW. Echoing their name back keeps that from becoming a list of
// exceptions here.
//
// A property requiredproperties asked for that we cannot supply stops the
// request rather than being omitted: a rate built from a partial request is a
// rate for a different vehicle.
//
// ── One login, many dealers (2026-09-25) ────────────────────────────────
// The dealer code used to come off the credential row, because a credential was
// a store. It now comes from the store's mapping in
// fni.store_provider_accounts, resolved through createTecAssuredClient(store),
// and the code actually sent is written to sessions.dealer_code_used.
//
// That last part is the point of recording it at all. Under one shared login
// the credential no longer identifies the dealer, and a mapping repointed at a
// new Dealer ID months from now must not be able to change what an existing
// contract says it was rated under. So the value is copied into the session at
// the moment it is sent, not joined back through the mapping later.

// ── Every provider the menu needs (2026-10-17) ───────────────────────────
// Rating now runs per provider: the deal's menu template names the providers
// its slots need, each is rated through its adapter in parallel, and each gets
// its own fni.rated_offers row. TecAssured goes through _shared/adapters/
// tecassured.ts, which is the code that used to sit in steps 4 to 6 below,
// unchanged in what it sends and receives. See _shared/rate-session.ts and
// docs/multi-provider.md, section 5.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { tecAssuredProviderId } from "../_shared/provider-rows.ts";
import { applyStaffEdits, parseStaffEdits } from "../_shared/staff-edits.ts";
import { rateSession, recordOutcome, type ProviderOutcome } from "../_shared/rate-session.ts";
import { choicesStillOffered, rateKey, statusAfterRating, type ChosenRate } from "../_shared/rerate.ts";
import { offerRowsFor } from "../_shared/provider-rows.ts";
import { familiesFromRow, familiesFromRows, type RatingRow } from "../_shared/rating-summary.ts";
import { priceFamilies } from "../_shared/plan-prices.ts";
import type { PricingRule } from "../_shared/planner-pricing.ts";
import { renewedBy } from "../_shared/sale-date.ts";
import {
  compareRefreshed,
  REFRESHED_HELD_EVENT,
  REFRESHED_UNCHANGED_EVENT,
  spentSelections,
  type SpentSelection,
  type VoidedContract,
} from "../_shared/spent-rates.ts";

// ─── Types ───────────────────────────────────────────────────────────────

interface RateRequest {
  session_id: string;
  overrides?: Record<string, unknown>;
  /**
   * Before the Submit confirmation: rate again if a selected rate is spent
   * (its contract was voided), and move the selections onto the fresh rates
   * when nothing about their price changed (_shared/spent-rates.ts).
   */
  refresh_spent?: boolean;
  /** The signed-in person's initials, for the session event. */
  refreshed_by?: string;
}

interface SessionRow {
  id: string;
  tenant_id: string;
  credential_id: string | null;
  store_id: string;
  status: string;
  deal_number: string | null;
  stock_number: string | null;
  vin: string | null;
  unit_year: number | null;
  unit_make: string | null;
  unit_model: string | null;
  unit_submodel: string | null;
  condition: string | null;
  vehicle_type_code: string | null;
  odometer: number | null;
  sale_price: number | null;
  amount_financed: number | null;
  apr: number | null;
  finance_term: number | null;
  payment: number | null;
  finance_type: string | null;
  sale_date: string | null;
  in_service_date: string | null;
  buyer_city: string | null;
  buyer_state: string | null;
  buyer_zip: string | null;
  vehicle_properties: Record<string, unknown> | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Recording what happened ─────────────────────────────────────────────
//
// Every exit from the rating attempt below writes a row, not just the happy one.
// Before this, fni.rated_offers held only successful quotes, so its absence had
// to stand for three different things at once -- never asked, asked and failed,
// asked and genuinely offered nothing -- and the planner resolved that ambiguity
// by telling the customer plans were not offered. On deal 14132 that was simply
// untrue: a correctly mapped Can-Am Defender that nobody had asked about.
//
// So the row is the record of the last ATTEMPT. `state` says which of the three
// outcomes it was and `error_detail` says why, for staff. See migration 0013.

/** One provider's outcome, as the caller reads it. */
function outcomeLine(o: ProviderOutcome): string {
  if (o.result.state === "Rated") {
    return `${o.provider.name}: Rated, ${o.productCount} ${o.productCount === 1 ? "product" : "products"}.`;
  }
  return `${o.provider.name}: ${o.result.reason}`;
}

// ─── Main handler ────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = new URL(req.url);

  const presented =
    url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
  if (!secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }

  let body: RateRequest;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { session_id, overrides } = body;
  if (!session_id) return json(400, { error: "session_id is required" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // The TecAssured provider, so an unexpected failure is still recorded as an
  // attempt rather than left as an absent row. In scope for the catch below.
  let providerId: string | null = null;

  try {
    // ── Step 1: Load session ───────────────────────────────────────────
    const { data: session, error: sessErr } = await supabase
      .schema("fni")
      .from("sessions")
      .select("*")
      .eq("id", session_id)
      .single();

    if (sessErr || !session) return json(404, { error: `Session ${session_id} not found` });

    const sess = session as SessionRow;
    providerId = await tecAssuredProviderId(supabase, sess.tenant_id);

    const terminalStatuses = ["Finalized", "Written Back", "Cancelled"];
    if (terminalStatuses.includes(sess.status)) {
      return json(400, { error: `Session is ${sess.status} and cannot be re-rated` });
    }

    // ── Step 2: The staff layer ────────────────────────────────────────
    //
    // Corrections made on the Verify screen, applied over the CRM's figures. This
    // is the whole reason those fields were made editable: a price the person at
    // the desk corrected has to be the price the provider is asked about, in BOTH
    // halves of the request. The properties array reads overrides out of
    // vehicle_properties already, but the documented top-level fields --
    // vehiclePrice, financeAmount, odometer -- come straight off the columns, so
    // substituting here is what keeps the two halves from describing two
    // different machines.
    //
    // In memory only. The columns keep the CRM's record; see migration 0016.
    const staffEdits = parseStaffEdits(
      (sess as unknown as Record<string, unknown>).staff_edits
    );
    const rateSource = applyStaffEdits(sess as unknown as Record<string, unknown>, staffEdits);

    // ── Step 2b: The overrides parameter ───────────────────────────────
    //
    // Predates the Verify screen and no caller sends it today: the console and
    // the planner both post session_id alone. It used to WRITE its values into
    // the session's columns, which is now exactly the thing the design forbids,
    // because it destroys the CRM figure that "differs from the CRM deal" has to
    // be measured against. So it stays as a way to rate a one-off what-if, and
    // it no longer persists anything.
    if (overrides && Object.keys(overrides).length > 0) {
      const allowedOverrides = [
        "vehicle_type_code", "unit_submodel", "odometer", "condition",
        "sale_price", "amount_financed", "apr", "finance_term",
        // The three finance columns _shared/finance-basis.ts actually reads.
        // finance_term_total and interest_rate are PREFERRED over finance_term and
        // apr, so without them an override of the older pair is silently shadowed:
        // the caller sets 48 months and the request still goes out with whatever
        // finance_term_total holds. tila_amount_financed does not reach the
        // request today -- financeAmount comes from amount_financed -- but it
        // decides which branch of the resolver answers, and a caller correcting a
        // deal's finance figures by hand should be able to set it.
        "finance_term_total", "interest_rate", "tila_amount_financed",
        "finance_type", "in_service_date", "vin", "unit_year",
        "unit_make", "unit_model", "sale_date", "vehicle_properties",
      ];

      for (const key of allowedOverrides) {
        if (key in overrides) rateSource[key] = overrides[key];
      }
    }

    if (body.refresh_spent === true) {
      return await refreshSpent(supabase, sess, rateSource, body.refreshed_by);
    }

    // ── Step 3: Rate every provider the menu needs ────────────────────
    //
    // Which login and Dealer ID TecAssured is called with is still resolved by
    // store, not by the session's credential_id: the mapping is the current
    // truth, and a session created before a store was configured starts working
    // the moment it is.
    const { template, outcomes } = await rateSession(
      supabase,
      { id: sess.id, tenant_id: sess.tenant_id, store_id: sess.store_id },
      rateSource
    );

    if (outcomes.length === 0) {
      return json(400, {
        error: template
          ? `The menu template "${template.name}" names no active provider's products, so there is nothing to rate.`
          : "This dealer group has no active provider to rate with.",
      });
    }

    const rated = outcomes.filter((o) => o.result.state === "Rated");
    const productCount = rated.reduce((n, o) => n + o.productCount, 0);
    // A failed re-rate keeps the last good offers (_shared/rerate.ts). Those
    // still current keep the deal presentable and submittable as it was.
    const kept = outcomes.filter((o) => o.kept);
    const keptCount = kept.reduce((n, o) => n + (o.kept!.current ? o.kept!.product_count : 0), 0);
    const warning = kept.length > 0 ? kept.map((o) => o.kept!.warning).join(" ") : null;

    // A re-rate after the customer has chosen keeps the session where it was
    // while every choice is still offered at the same rate (_shared/rerate.ts).
    const { data: chosenRows } = await supabase
      .schema("fni")
      .from("selected_products")
      .select("provider_id, provider_product_id, rate_unique_id")
      .eq("session_id", session_id)
      .eq("disposition", "Included");
    const offeredRates = new Set(
      rated.flatMap((o) =>
        o.result.state === "Rated"
          ? o.result.offers.map((f) => rateKey(o.provider.id, f.product_code, f.rate_key))
          : []
      )
    );
    const keptProviders = new Set(kept.filter((o) => o.kept!.current).map((o) => o.provider.id));
    const nextStatus = statusAfterRating(
      String(sess.status),
      productCount,
      choicesStillOffered((chosenRows ?? []) as ChosenRate[], offeredRates, keptProviders)
    );
    const ta = outcomes.find((o) => o.tecassured);

    // ── Step 4: Record status, the template, the providers, and who acted ──
    // The session only advances to Rated when there is something to present.
    // The login and Dealer ID are copies on purpose: together they answer
    // "who rated this", and neither may drift when configuration changes. They
    // are written only when TecAssured actually answered.
    const taAnswered = ta && ta.tecassured && ta.result.state !== "Failed";
    const { error: statusErr } = await supabase
      .schema("fni")
      .from("sessions")
      .update({
        status: nextStatus,
        menu_template_id: template?.id ?? null,
        rated_provider_ids: outcomes.map((o) => o.provider.id),
        ...(taAnswered
          ? { credential_id: ta.tecassured!.credentialId, dealer_code_used: ta.tecassured!.dealer_code }
          : {}),
      })
      .eq("id", session_id);

    if (statusErr) console.error(`Failed to update session status: ${statusErr.message}`);

    const providers = outcomes.map((o) => ({
      provider: o.provider.name,
      state: o.result.state,
      product_count: o.kept ? o.kept.product_count : o.productCount,
      line: o.kept ? o.kept.warning : outcomeLine(o),
    }));

    // ── Step 5: Answer ────────────────────────────────────────────────
    if (productCount === 0 && keptCount > 0) {
      // Nothing new, but the last good offers stand: the status and the
      // customer's choices are untouched, and staff are told why.
      return json(200, {
        session_id,
        status: sess.status,
        product_count: keptCount,
        kept_offers: true,
        warning,
        providers,
        menu_template: template?.name ?? null,
        dealer_code: ta?.tecassured?.dealer_code ?? null,
      });
    }

    if (productCount === 0) {
      // Nothing to present. Every provider's reason, in its own words, is what
      // a staff member needs to see.
      const missingVtype = !rateSource.vehicle_type_code && ta !== undefined;
      return json(400, {
        error: providers.map((p) => p.line).join(" "),
        status: outcomes.some((o) => o.result.state === "Not Offered") ? "Not Offered" : "Failed",
        providers,
        menu_template: template?.name ?? null,
        dealer_code: ta?.tecassured?.dealer_code ?? null,
        unsupplied_properties: ta?.tecassured?.unsupplied ?? [],
        ...(missingVtype ? { missing_fields: ["vehicle_type_code"] } : {}),
      });
    }

    return json(200, {
      session_id,
      status: nextStatus,
      product_count: productCount,
      providers,
      menu_template: template?.name ?? null,
      dealer_code: ta?.tecassured?.dealer_code ?? null,
      environment: ta?.tecassured?.environment ?? null,
      offer: ta?.result.response ?? null,
      rated_at: new Date().toISOString(),
      // Another provider failed and its last good offers were kept.
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-rate-vehicle error:", message);

    // A timeout, a dropped connection, a malformed response. Recorded so the
    // planner shows neutral copy rather than inferring "not offered" from the
    // absence of a quote.
    if (providerId) {
      await recordOutcome(supabase, session_id, {
        provider: { id: providerId, name: "TecAssured", kind: "Connected", adapter: "TecAssured", active: true },
        productCount: 0,
        result: { state: "Failed", reason: `Rating failed: ${message}` },
      });
    }

    return json(500, { error: message });
  }
});

// ── Refreshing spent rates before a submit (2026-10-28) ──────────────────
//
// A rate whose contract was voided is spent: the provider refuses it ("One or
// more of these products have been voided. Please re-rate and try again"). In
// iTap a voided contract is written again with no re-rate a person sees, so
// before the Submit confirmation opens, a deal with a spent rate is rated
// again here, through the same rateSession staff use, and its offers stored
// the usual way. Every selection the submit will send is matched to the fresh
// offer (a fresh quote can renumber every rate) and compared to the cent
// (_shared/spent-rates.ts):
//
//   unchanged  each selection moves onto its fresh rate (rate ID and
//              snapshot; no price column is written), and the session event
//              "Rating refreshed after a void: prices unchanged" is recorded
//   otherwise  nothing moves, the submit is held, and "Rating refreshed after
//              a void: prices changed, submit held" records each difference
//   failed     the provider's error is answered; the last good offers are
//              kept as any failed re-rate keeps them, and nothing is submitted
//
// The session's status is left as it is: the customer's choices stand until
// staff review them. This runs once per press of Submit and never retries.

async function refreshSpent(
  supabase: SupabaseClient,
  sess: SessionRow,
  rateSource: Record<string, unknown>,
  by: unknown
): Promise<Response> {
  const who = renewedBy(by);

  // What the submit will send: the Included selections from providers whose
  // contracts go through their API.
  const { data: chosen, error: chosenErr } = await supabase
    .schema("fni")
    .from("selected_products")
    .select("id, provider_id, provider_product_id, product_name, rate_unique_id, selected_options, customer_price, retail_price, providers!inner(contract_method)")
    .eq("session_id", sess.id)
    .eq("disposition", "Included")
    .eq("providers.contract_method", "Through API");
  if (chosenErr) return json(500, { error: `The customer's choices could not be read: ${chosenErr.message}` });
  const selections = (chosen ?? []) as unknown as (SpentSelection & { id: string })[];

  const { data: agreements } = await supabase.schema("fni").from("agreements").select("id").eq("session_id", sess.id);
  const agreementIds = ((agreements ?? []) as { id: string }[]).map((a) => a.id);
  const { data: contractRows } = agreementIds.length > 0
    ? await supabase
        .schema("fni")
        .from("agreement_products")
        .select("provider_product_id, rate_unique_id, status, voided_at")
        .in("agreement_id", agreementIds)
    : { data: [] };

  const beforeRows = await offerRowsFor(supabase, sess.id);
  const taBefore = beforeRows.find((r) => r.provider?.adapter === "TecAssured") ?? null;
  const spent = spentSelections(selections, (contractRows ?? []) as VoidedContract[], taBefore?.rated_at ?? null);
  if (spent.length === 0) return json(200, { session_id: sess.id, outcome: "not_spent" });

  // The quote the selections were made from, read before it is replaced.
  const oldFamilies = beforeRows.flatMap((r) => familiesFromRow({ ...(r as unknown as RatingRow), out_of_date: false }));

  // ── Rate again, the way staff do ──────────────────────────────────────
  const { template, outcomes } = await rateSession(
    supabase,
    { id: sess.id, tenant_id: sess.tenant_id, store_id: sess.store_id },
    rateSource
  );
  const ta = outcomes.find((o) => o.tecassured);
  if (!ta || ta.result.state !== "Rated") {
    const reason = ta ? (ta.result.state === "Rated" ? "" : ta.result.reason) : "No provider rated this deal.";
    return json(502, {
      session_id: sess.id,
      outcome: "failed",
      error: `The rating could not be refreshed, so nothing was submitted. ${reason}`.trim(),
    });
  }

  // The same session fields a rating writes, except the status.
  await supabase
    .schema("fni")
    .from("sessions")
    .update({
      menu_template_id: template?.id ?? null,
      rated_provider_ids: outcomes.map((o) => o.provider.id),
      ...(ta.tecassured ? { credential_id: ta.tecassured.credentialId, dealer_code_used: ta.tecassured.dealer_code } : {}),
    })
    .eq("id", sess.id);

  // ── The fresh offer, priced as the planner prices it ─────────────────
  const { data: ruleRows } = await supabase
    .schema("fni")
    .from("pricing_rules")
    .select("*")
    .eq("tenant_id", sess.tenant_id)
    .or(`store_id.eq.${sess.store_id},store_id.is.null`)
    .eq("active", true);
  const freshPriced = priceFamilies(
    familiesFromRows((await offerRowsFor(supabase, sess.id)) as unknown as RatingRow[]),
    (ruleRows ?? []) as unknown as PricingRule[]
  );

  const { lines, unchanged } = compareRefreshed(selections, oldFamilies, freshPriced);
  const record = lines.map(({ snapshot: _snapshot, ...l }) => l);

  if (unchanged) {
    for (const [i, l] of lines.entries()) {
      if (l.from_rate === l.to_rate) continue;
      const { error: moveErr } = await supabase
        .schema("fni")
        .from("selected_products")
        .update({ rate_unique_id: l.to_rate, rate_snapshot: l.snapshot })
        .eq("id", selections[i].id)
        .eq("rate_unique_id", l.from_rate);
      if (moveErr) {
        return json(500, { session_id: sess.id, outcome: "failed", error: `The selections could not be moved onto the fresh rating: ${moveErr.message}` });
      }
    }
  }

  const { error: eventErr } = await supabase
    .schema("fni")
    .from("session_events")
    .insert({
      session_id: sess.id,
      event: unchanged ? REFRESHED_UNCHANGED_EVENT : REFRESHED_HELD_EVENT,
      detail: { lines: record, spent: spent.map((s) => s.rate_unique_id) },
      created_by: who,
    });
  if (eventErr) console.error(`fni-rate-vehicle refresh event not recorded for ${sess.id}: ${eventErr.message}`);

  return json(200, { session_id: sess.id, outcome: unchanged ? "unchanged" : "held", lines: record });
}
