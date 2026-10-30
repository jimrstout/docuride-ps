// fni-dx1-check/index.ts
//
// The F&I check against DX1, called by the CRM's Generate gate
// (DC_Generate_Contract_Gated) alongside its other checks, and by Details when
// it loads. Compares the DocuRide record's eight product slots, read fresh
// from the CRM, with the deal's live contracts (_shared/dx1-check.ts), and the
// finance term the customer chose on the menu, when it is not the deal's own,
// with the record's Term_Months and Interest_Rate (_shared/finance-term-check.ts).
// Not run
// from zoho-sync: the DX1 pull writes without workflow triggers, so zoho-sync
// never sees those edits.
//
// POST, header x-webhook-secret: <FNI_WEBHOOK_SECRET>, JSON:
//   { "zoho_deal_id": "<CRM record id>" }     the CRM's gate
//   { "session_id": "<DocuRide session>" }    Details
//
// Always HTTP 200 with JSON, exactly { status, blocking, warnings }:
//   "Nothing to check"   no session, or no live contract and no chosen term to
//                        compare. Both lists empty.
//   "Match"              everything agrees. Both lists empty.
//   "Problems"           at least one line in either list.
// A bad secret is 401. Anything that goes wrong inside, or a check that would
// take longer than the gate can wait (4.5 seconds), answers "Nothing to check"
// with the warning "F&I contracts could not be checked against DX1", so the
// gate lets Generate through. A CRM term or rate that cannot be read is the
// warning "Finance terms could not be checked against the CRM.", never a block.
//
// PS never writes a CRM field here: it only reads the record. The result is
// kept on the session (sessions.dx1_check, dx1_checked_at, migration 0043) for
// Details, and a session event, signed System, is added only when it changes.
// Logs carry the session id, counts and the status only: never a price, a
// description, a name or the record.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { getRecord } from "../_shared/zoho.ts";
import { programName } from "../_shared/program-names.ts";
import {
  FAILED,
  NOTHING,
  compareToDx1,
  sameResult,
  toCents,
  type CheckResult,
  type Contract,
} from "../_shared/dx1-check.ts";
import { chosenTermToCheck, compareFinanceTerm, withFinanceTerm, type ChosenTerm } from "../_shared/finance-term-check.ts";

const MODULE = "DocuRide";
const BUDGET_MS = 4500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_ID = /^\d{10,25}$/;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The deal's live and voided contracts, as the comparison reads them. */
async function contractsFor(supabase: SupabaseClient, sessionId: string): Promise<{ live: Contract[]; voided: Contract[] }> {
  const { data: agreements, error: aErr } = await supabase.schema("fni").from("agreements").select("id").eq("session_id", sessionId);
  if (aErr) throw new Error("agreements");
  const ids = ((agreements ?? []) as { id: string }[]).map((a) => a.id);
  if (ids.length === 0) return { live: [], voided: [] };
  const { data: rows, error } = await supabase
    .schema("fni")
    .from("agreement_products")
    .select("contract_number, provider_id, provider_product_id, product_name, term_months, final_customer_price, status, provider:providers(name)")
    .in("agreement_id", ids);
  if (error) throw new Error("contracts");
  const list = (rows ?? []) as unknown as {
    contract_number: string | null; provider_id: string | null; provider_product_id: string | null; product_name: string | null;
    term_months: number | null; final_customer_price: number | string | null; status: string; provider: { name: string } | null;
  }[];

  // Each contract's category, from the catalog by provider and product.
  const codes = [...new Set(list.map((r) => r.provider_product_id).filter((c): c is string => !!c))];
  const { data: catalog } = codes.length
    ? await supabase.schema("fni").from("product_catalog").select("provider_id, product_code, category").in("product_code", codes).is("store_id", null)
    : { data: [] };
  const cat = new Map(((catalog ?? []) as { provider_id: string; product_code: string; category: string | null }[])
    .map((c) => [`${c.provider_id}:${c.product_code}`, c.category]));

  const toContract = (r: (typeof list)[number]): Contract => ({
    contract_number: r.contract_number ?? "with no number",
    category: cat.get(`${r.provider_id}:${r.provider_product_id}`) ?? null,
    product_name: r.product_name ?? "",
    plan: programName(r.product_name),
    term_months: r.term_months,
    cents: toCents(r.final_customer_price),
    provider_name: r.provider?.name ?? null,
  });
  return {
    live: list.filter((r) => r.status === "Live" || r.status === "Submit Status Unknown").map(toContract),
    voided: list.filter((r) => r.status === "Voided").map(toContract),
  };
}

/** Keep the result on the session; an event only when it changed. */
async function keep(supabase: SupabaseClient, sessionId: string, previous: CheckResult | null, result: CheckResult): Promise<void> {
  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({ dx1_check: result, dx1_checked_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (error) console.error("fni-dx1-check: result not kept", { session: sessionId, code: error.code ?? null });
  if (sameResult(previous, result)) return;
  const { error: evErr } = await supabase.schema("fni").from("session_events").insert({
    session_id: sessionId,
    event: `F&I check against DX1: ${result.status}`,
    detail: { blocking: result.blocking.length, warnings: result.warnings.length },
    created_by: "System",
  });
  if (evErr) console.error("fni-dx1-check: event not recorded", { session: sessionId, code: evErr.code ?? null });
}

async function check(body: Record<string, unknown>): Promise<CheckResult> {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const zohoId = typeof body.zoho_deal_id === "string" || typeof body.zoho_deal_id === "number" ? String(body.zoho_deal_id).trim() : "";
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
  if (!RECORD_ID.test(zohoId) && !UUID.test(sessionId)) return FAILED;

  let q = supabase.schema("fni").from("sessions").select("id, zoho_deal_id, dx1_check, finance_type, lienholder_name, menu_choice");
  q = UUID.test(sessionId) ? q.eq("id", sessionId) : q.eq("zoho_deal_id", zohoId);
  const { data: session, error } = await q.maybeSingle();
  if (error) throw new Error("session");
  const s = session as
    | { id: string; zoho_deal_id: string | null; dx1_check: CheckResult | null; finance_type: unknown; lienholder_name: unknown; menu_choice: unknown }
    | null;
  if (!s) return NOTHING;

  const { live, voided } = await contractsFor(supabase, s.id);
  const chosen: ChosenTerm | null = chosenTermToCheck(s);
  if (live.length === 0 && !chosen) {
    await keep(supabase, s.id, s.dx1_check, NOTHING);
    console.log("fni-dx1-check", { session: s.id, live: 0, status: NOTHING.status });
    return NOTHING;
  }

  // Read fresh from the CRM on every call: the DX1 pull changes it without
  // telling anyone. A read that fails never blocks, and is not kept: the
  // products say they could not be checked, and so does the term.
  const record = s.zoho_deal_id ? await getRecord(MODULE, s.zoho_deal_id).catch(() => null) : null;
  if (!record) {
    console.error("fni-dx1-check: could not check", { session: s.id, step: s.zoho_deal_id ? "crm" : "no crm id" });
    return withFinanceTerm(live.length === 0 ? NOTHING : FAILED, compareFinanceTerm(chosen, null));
  }
  const products = live.length === 0 ? NOTHING : compareToDx1(live, voided, record);
  const result = withFinanceTerm(products, compareFinanceTerm(chosen, record));
  await keep(supabase, s.id, s.dx1_check, result);
  console.log("fni-dx1-check", {
    session: s.id, live: live.length, term: chosen ? "checked" : "none", status: result.status,
    blocking: result.blocking.length, warnings: result.warnings.length,
  });
  return result;
}

serve(async (req: Request) => {
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  const url = new URL(req.url);
  const presented = req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  const configured = Deno.env.get("FNI_WEBHOOK_SECRET");
  if (!secretsMatch(presented, configured)) {
    console.warn("fni-dx1-check auth failed", { configuredLength: configured?.length ?? 0, presentedLength: presented?.length ?? 0 });
    return reply(401, { error: "Unauthorized" });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return reply(200, FAILED);
  }

  // The gate is waiting: never longer than the budget, never anything but the JSON.
  let timer: number | undefined;
  const late = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(() => {
      console.error("fni-dx1-check: over budget, answered could not check");
      resolve(FAILED);
    }, BUDGET_MS);
  });
  try {
    const result = await Promise.race([check(body), late]);
    return reply(200, { status: result.status, blocking: result.blocking, warnings: result.warnings });
  } catch (err) {
    console.error("fni-dx1-check: could not check", { step: err instanceof Error ? err.message : "unknown" });
    return reply(200, FAILED);
  } finally {
    clearTimeout(timer);
  }
});
