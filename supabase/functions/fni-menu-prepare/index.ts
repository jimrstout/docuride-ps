// fni-menu-prepare/index.ts
//
// Prepare menu, on the staff side (docs/multi-provider.md section 25,
// migration 0045). Reached from Details before presenting.
//
// GET  ?session_id=<uuid>
//   The deal's sheet (_shared/menu-prepare.ts): columns across, categories
//   down, each cell's option from the preset (with fallbacks) or as prepared,
//   every rated option with its dealer cost, price and band, the deal's
//   surcharges, purchased products, and the payment basis for the column
//   footers.
//
// POST { session_id, action: "save", cells, prices, surcharges, set_by,
//        manager_id?, manager_name?, reason? }
//   Saves the prepared menu. Prices are per option, in cents before
//   surcharges, never below dealer cost. One above the band needs a manager
//   (fni.is_menu_manager, whose sign-in the console checked) and a reason;
//   both go in a session event. Refused once the customer has chosen a
//   package: prices are locked then.
//
// POST { session_id, action: "unlock", set_by }
//   Back to Prepare menu after the customer chose a package: the prices
//   unlock, and the session event says who did it.
//
// Auth: FNI_WEBHOOK_SECRET, as every staff function. Logs carry the session
// id, counts and outcomes only: never a price, a product or a name.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { loadSheet } from "../_shared/menu-prepare-rows.ts";
import { checkPreparation, optionFor, type Preparation } from "../_shared/menu-prepare.ts";
import { sessionCap, sessionPaymentBasis } from "../_shared/plan-prices.ts";
import { renewedBy } from "../_shared/sale-date.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PREPARED_EVENT = "Menu prepared";
export const ABOVE_BAND_EVENT = "Price above the band allowed by a manager on Prepare menu";
export const UNLOCKED_EVENT = "Returned to Prepare menu after the customer chose a package";
export const LOCKED =
  "The customer chose a package, so its prices are locked. Return to Prepare menu to change them; that is recorded on the deal.";
export const NEEDS_MANAGER = "A price above the band needs a manager to sign in and give a reason.";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function session(supabase: SupabaseClient, id: string): Promise<Record<string, unknown> | null> {
  const { data } = await supabase.schema("fni").from("sessions").select("*").eq("id", id).maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

async function reply(supabase: SupabaseClient, s: Record<string, unknown>, status = 200, extra: Record<string, unknown> = {}) {
  const { sheet, out_of_date } = await loadSheet(supabase, s);
  const basis = sessionPaymentBasis(s);
  return json(status, {
    ...extra,
    session: {
      id: s.id,
      deal_number: s.deal_number ?? null,
      vehicle: [s.unit_year, s.unit_make, s.unit_model].filter(Boolean).join(" "),
      prepared_at: s.menu_prepared_at ?? null,
      prepared_by: s.menu_prepared_by ?? null,
      locked_at: s.menu_prices_locked_at ?? null,
    },
    out_of_date,
    payment: {
      has_payment: basis.hasPayment,
      principal: basis.principal,
      rate: basis.ratePercent,
      term_months: basis.termMonths,
      cap: sessionCap(s, basis),
    },
    sheet,
  });
}

async function isManager(supabase: SupabaseClient, id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !UUID.test(id)) return false;
  const { data, error } = await supabase.schema("fni").rpc("is_menu_manager", { p_user: id });
  return !error && data === true;
}

serve(async (req: Request) => {
  const url = new URL(req.url);
  const presented = req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  if (!secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"))) return json(401, { error: "Unauthorized" });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    if (req.method === "GET") {
      const id = url.searchParams.get("session_id") ?? "";
      if (!UUID.test(id)) return json(400, { error: "A well-formed session_id is required" });
      const s = await session(supabase, id);
      if (!s) return json(404, { error: "Session not found" });
      return await reply(supabase, s);
    }
    if (req.method !== "POST") return json(405, { error: "GET or POST only" });

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: "A JSON body is required" });
    }
    const id = typeof body.session_id === "string" ? body.session_id : "";
    if (!UUID.test(id)) return json(400, { error: "A well-formed session_id is required" });
    const s = await session(supabase, id);
    if (!s) return json(404, { error: "Session not found" });
    const who = renewedBy(body.set_by);

    if (body.action === "unlock") {
      if (!s.menu_prices_locked_at) return await reply(supabase, s);
      const { error } = await supabase.schema("fni").from("sessions").update({ menu_prices_locked_at: null }).eq("id", id);
      if (error) return json(500, { error: error.message });
      await supabase.schema("fni").from("session_events").insert({ session_id: id, event: UNLOCKED_EVENT, detail: {}, created_by: who });
      console.log("fni-menu-prepare unlocked", { session: id });
      return await reply(supabase, (await session(supabase, id))!);
    }

    if (body.action !== "save") return json(400, { error: "action must be save or unlock" });
    if (s.menu_prices_locked_at) return json(409, { error: LOCKED });

    const surcharges = Array.isArray(body.surcharges) ? body.surcharges.map(String) : [];
    // The sheet with the surcharges asked for, so the check sees what will be offered.
    const { sheet } = await loadSheet(supabase, { ...s, menu_surcharges: surcharges });
    const prep: Preparation = {
      cells: (body.cells ?? {}) as Preparation["cells"],
      prices: Object.fromEntries(
        Object.entries((body.prices ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v)])
      ),
      surcharges,
    };
    const check = checkPreparation(sheet, prep);
    if (check.errors.length > 0) return json(400, { error: check.errors.join(" "), errors: check.errors });

    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    const managerName = typeof body.manager_name === "string" ? body.manager_name.trim().slice(0, 120) : "";
    if (check.above_band.length > 0 && (!(await isManager(supabase, body.manager_id)) || reason === "" || managerName === "")) {
      return json(403, { error: NEEDS_MANAGER, above_band: check.above_band });
    }

    const now = new Date().toISOString();
    if (check.writes.length > 0) {
      const { error } = await supabase.schema("fni").from("session_menu_prices").upsert(
        check.writes.map((w) => ({
          session_id: id,
          option_key: w.key,
          retail_price: w.retail_cents / 100,
          above_band: w.above_band,
          approved_by: w.above_band ? managerName : null,
          reason: w.above_band ? reason : null,
          set_by: who,
          set_at: now,
        })),
        { onConflict: "session_id,option_key" }
      );
      if (error) return json(500, { error: `The prices could not be saved: ${error.message}` });
    }

    const { error: sErr } = await supabase.schema("fni").from("sessions").update({
      menu_prepared: prep.cells,
      menu_surcharges: surcharges,
      menu_prepared_at: now,
      menu_prepared_by: who,
    }).eq("id", id);
    if (sErr) return json(500, { error: `The menu could not be saved: ${sErr.message}` });

    const events: Record<string, unknown>[] = [
      { session_id: id, event: PREPARED_EVENT, detail: { prices_set: check.writes.length, surcharges: surcharges.length }, created_by: who },
    ];
    if (check.above_band.length > 0) {
      events.push({
        session_id: id,
        event: ABOVE_BAND_EVENT,
        detail: {
          manager: managerName,
          reason,
          products: check.above_band.map((k) => {
            const f = optionFor(sheet, k);
            return f ? `${f.plan.plan_name}, ${f.option.label}` : k;
          }),
        },
        created_by: who,
      });
    }
    const { error: eErr } = await supabase.schema("fni").from("session_events").insert(events);
    if (eErr) console.error("fni-menu-prepare events not recorded", { session: id, code: eErr.code ?? null });

    console.log("fni-menu-prepare saved", { session: id, prices: check.writes.length, above_band: check.above_band.length, surcharges: surcharges.length });
    return await reply(supabase, (await session(supabase, id))!, 200, { saved: true });
  } catch (err) {
    console.error("fni-menu-prepare error", { kind: err instanceof Error ? err.name : "error" });
    return json(500, { error: "Prepare menu is unavailable right now. Try again shortly." });
  }
});
