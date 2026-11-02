// fni-rate-probe/index.ts: rate a deal on the provider's QA server with one
// or two request values changed, kept apart from the deal's own rating.
//
// Why it exists (migration 0050): the provider's form defines coded values
// (new.used N=New, U=Used; finance.type N=None, F=Loan, B=Balloon, L=Lease)
// and PS sends the labels. No stored rating has returned a New program or GAP.
// A probe answers whether the codes change that, without touching the deal.
//
// ── Who can start one ───────────────────────────────────────────────────
// Only the database. A probe is a row in fni.rate_probes with a one-time
// token the database made; the same SQL statement posts the row's id and
// token here through pg_net. This function runs a row only while it is
// Requested, recent and the token matches, and spends the token as it starts.
// No CRM, customer or public path reaches it, and no long-lived secret is
// involved.
//
// ── What it does ────────────────────────────────────────────────────────
// The request is the one a real rating sends, built by the same code
// (_shared/rate-request.ts) from the same session with the same staff
// corrections, with only the probe's values changed (_shared/rate-probe.ts).
// It is sent on the QA server only: a login that is not Test is refused.
//
// ── What it never does ──────────────────────────────────────────────────
// It writes nothing but its own row in fni.rate_probes. Never fni.sessions,
// fni.rated_offers or fni.selected_products; it does not read the CRM's sale
// date afresh (that read can write the session), and it does not fill the
// required-properties cache. Never deal 14957.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createTecAssuredClient } from "../_shared/tecassured.ts";
import { applyStaffEdits, parseStaffEdits } from "../_shared/staff-edits.ts";
import { parseRequiredProperties, readRateProperties } from "../_shared/rate-properties.ts";
import { buildRateRequest, type RateSource } from "../_shared/rate-request.ts";
import {
  applyProbeOverrides,
  NEVER_PROBE_DEAL,
  parseProbeOverrides,
  PROBE_WAIT_MINUTES,
} from "../_shared/rate-probe.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Ends the probe's row. The only write this function makes, besides claiming the row. */
async function finish(
  supabase: SupabaseClient,
  id: string,
  fields: { status: "Done" | "Failed"; error_detail?: string | null; environment?: string | null; request_payload?: unknown; response_payload?: unknown },
): Promise<void> {
  await supabase.schema("fni").from("rate_probes")
    .update({ ...fields, finished_at: new Date().toISOString() })
    .eq("id", id);
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only." });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "The body is not JSON." });
  }
  const probeId = String(body.probe_id ?? "");
  const token = String(body.token ?? "");
  if (!UUID.test(probeId) || !UUID.test(token)) return json(401, { error: "Not a probe waiting to run." });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Claim the row and spend its token in one step: a second call with the
  // same token finds nothing.
  const since = new Date(Date.now() - PROBE_WAIT_MINUTES * 60_000).toISOString();
  const { data: claimed, error: claimErr } = await supabase.schema("fni").from("rate_probes")
    .update({ status: "Running", token: null, started_at: new Date().toISOString() })
    .eq("id", probeId).eq("token", token).eq("status", "Requested").gt("requested_at", since)
    .select("id, session_id, overrides");
  if (claimErr) return json(500, { error: "The probe could not be read." });
  const probe = (claimed ?? [])[0] as { id: string; session_id: string; overrides: unknown } | undefined;
  if (!probe) return json(401, { error: "Not a probe waiting to run." });

  const fail = async (reason: string, extra: Record<string, unknown> = {}) => {
    await finish(supabase, probe.id, { status: "Failed", error_detail: reason, ...extra });
    return json(200, { status: "Failed", error: reason });
  };

  try {
    const parsed = parseProbeOverrides(probe.overrides);
    if ("error" in parsed) return await fail(parsed.error);

    const { data: session } = await supabase.schema("fni").from("sessions").select("*").eq("id", probe.session_id).maybeSingle();
    if (!session) return await fail("That deal's session was not found.");
    const s = session as Record<string, unknown>;
    if (String(s.deal_number ?? "") === NEVER_PROBE_DEAL) return await fail(`Deal ${NEVER_PROBE_DEAL} is never probed.`);

    // The same rate source a real rating uses: the session with staff
    // corrections applied, in memory only.
    const rateSource = applyStaffEdits(s, parseStaffEdits(s.staff_edits));
    const vtype = (rateSource.vehicle_type_code as string | null) ?? null;
    if (!vtype) return await fail("The deal has no vehicle type the provider rates.");

    const store = await createTecAssuredClient(String(s.store_id), supabase);
    const environment = store.credentials.environment;
    if (environment !== "Test") return await fail("Probes run on the provider's QA server only, and this store's login is not the QA one.", { environment });

    // What the provider asks for: the overnight cache, else asked live. Never
    // written back, so the probe leaves the cache as it found it.
    const cached = await readRateProperties(supabase, store.account.id, vtype);
    const required = cached && cached.status === "Cached"
      ? parseRequiredProperties(cached.properties).properties
      : parseRequiredProperties(await store.client.getRequiredProperties(vtype)).properties;

    const built = buildRateRequest(required, rateSource as unknown as RateSource, { dealerCode: store.dealerCode, vtype });
    if (built.dateProblem) return await fail(built.dateProblem, { environment });
    if (built.missing.length > 0) {
      return await fail(`The deal does not carry ${built.missing.map((m) => m.name).join(", ")}, so it cannot be rated.`, { environment });
    }
    const request = applyProbeOverrides(built.request, parsed.overrides);

    let response: unknown;
    try {
      response = await store.client.rateVehicle(request);
    } catch (err) {
      return await fail(`The provider did not answer: ${err instanceof Error ? err.message : String(err)}`, { environment, request_payload: request });
    }
    const refusal = response && typeof response === "object" ? (response as Record<string, unknown>).error : null;
    if (typeof refusal === "string" && refusal.trim() !== "") {
      return await fail(`The provider refused the request: ${refusal.trim()}`, { environment, request_payload: request, response_payload: response });
    }

    await finish(supabase, probe.id, { status: "Done", environment, request_payload: request, response_payload: response });
    return json(200, { status: "Done" });
  } catch (err) {
    return await fail(`The probe stopped: ${err instanceof Error ? err.message : String(err)}`);
  }
});
