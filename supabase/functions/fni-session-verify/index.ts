// fni-session-verify/index.ts
//
// The staff-only Verify step. Nothing customer-facing ever calls this and
// nothing it returns is written for a customer to read.
//
// ── Why a gate at all ───────────────────────────────────────────────────
// Making the planner rate itself fixed a customer being told their machine had
// no plans. It also meant a rate request would be assembled, unattended, from a
// deal nobody had looked at -- and two of the seventeen fields TecAssured wants
// for a UTV have no source in the CRM. A rate is a price a customer is shown, so
// a person now checks the inputs and says so, and the planner will not rate
// until they have.
//
// Input:
//   GET  ?session_id=<uuid>              -> the sheet: every field, value, source
//   POST { session_id, action }          -> save | decode | refresh | verify
//
// Auth: FNI_WEBHOOK_SECRET, as every other fni function. The console's sign-in
// decides who reaches the layer that holds the secret.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { createTecAssuredClient } from "../_shared/tecassured.ts";
import { getRecord } from "../_shared/zoho.ts";
import { crmRatingFields } from "../_shared/crm-fields.ts";
import {
  buildVerification,
  changedInputs,
  dealTypeLabel,
  ratingInputs,
  STAFF_ENTERED,
  type VerificationSource,
} from "../_shared/verification.ts";
import { parseRequiredProperties, readRateProperties } from "../_shared/rate-properties.ts";
import {
  duplicateVinWarning,
  occupiesSlot,
  sessionIsOpen,
  TERMINAL_SESSION_STATUSES,
  type ContractRef,
  type OpenSessionRef,
} from "../_shared/duplicates.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The only fields a staff member may type. Anything else is CRM's or nobody's. */
const EDITABLE_KEYS: readonly string[] = [
  STAFF_ENTERED.engineCc,
  STAFF_ENTERED.warrantyMonths,
  "fuel.type",
];

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

function admin(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

/** The session columns this function reads. Explicit, so a new PII column on
 *  fni.sessions cannot widen what a staff screen receives by accident. */
const COLUMNS = [
  "id", "store_id", "tenant_id", "zoho_deal_id", "status", "is_test",
  "deal_number", "stock_number", "finance_type", "sale_date",
  "vin", "unit_year", "unit_make", "unit_model", "condition",
  "vehicle_type_code", "odometer", "in_service_date",
  "sale_price", "amount_financed", "finance_term", "apr",
  "buyer_city", "buyer_state", "buyer_zip",
  "vehicle_properties", "vin_decode", "vin_decode_at",
  "verification_state", "verified_at", "verified_by", "verified_snapshot",
  // For the duplicate warnings and the submit lock, both of which the verify
  // screen now shows.
  "expires_at", "submit_state", "submit_detail",
].join(",");

async function loadSession(
  supabase: SupabaseClient,
  sessionId: string
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .schema("fni")
    .from("sessions")
    .select(COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * Case 3: the same machine on another open deal.
 *
 * Read-only and advisory. Nothing is blocked, because two deals on one VIN is
 * as often a legitimate re-write as it is a mistake, and DocuRide cannot tell
 * which from here. Staff can.
 *
 * Scoped to the tenant: two dealer groups can honestly hold the same VIN, one
 * having sold the machine to the other.
 */
async function duplicateVinSessions(
  supabase: SupabaseClient,
  s: Record<string, unknown>
): Promise<OpenSessionRef[]> {
  const vin = typeof s.vin === "string" ? s.vin.trim() : "";
  if (vin === "") return [];

  let q = supabase
    .schema("fni")
    .from("sessions")
    .select("id, deal_number, status, expires_at")
    .eq("vin", vin)
    .neq("id", s.id as string)
    .not("status", "in", `(${TERMINAL_SESSION_STATUSES.join(",")})`);

  if (typeof s.tenant_id === "string" && s.tenant_id !== "") {
    q = q.eq("tenant_id", s.tenant_id);
  }

  const { data } = await q;
  return ((data ?? []) as OpenSessionRef[]).filter((o) => sessionIsOpen(o));
}

/**
 * Contracts already on this session.
 *
 * The verify screen is where staff land when CRM sends a deal through a second
 * time, so it is where "this is already done" has to be visible. Voided rows
 * are left out: they no longer hold a product's slot, and listing them would
 * read as paperwork that still stands.
 */
async function liveContracts(
  supabase: SupabaseClient,
  sessionId: string
): Promise<ContractRef[]> {
  const { data: agreements } = await supabase
    .schema("fni")
    .from("agreements")
    .select("id")
    .eq("session_id", sessionId);

  const ids = ((agreements ?? []) as { id: string }[]).map((a) => a.id);
  if (ids.length === 0) return [];

  const { data } = await supabase
    .schema("fni")
    .from("agreement_products")
    .select("provider_product_id, contract_number, product_name, status")
    .in("agreement_id", ids);

  return ((data ?? []) as ContractRef[]).filter(occupiesSlot);
}

/**
 * What TecAssured asks for, for this store and this vehicle type.
 *
 * From the cache only. A cold cache returns nothing and the sheet is then not
 * ready, which is the honest answer: we do not yet know what is needed, and a
 * screen that lets Verify be pressed while not knowing is the thing this
 * function exists to prevent. fni-refresh-rate-properties fills the cache
 * overnight, and fni-rate-vehicle fills it on demand.
 */
async function requiredFor(
  supabase: SupabaseClient,
  storeId: string,
  vtype: unknown
): Promise<{ properties: string[]; reason: string | null }> {
  if (typeof vtype !== "string" || vtype.trim() === "") {
    return {
      properties: [],
      reason:
        "This unit has no TecAssured vehicle type, so there is no list of " +
        "fields to check. The deal's body type is either blank or not one we map.",
    };
  }

  const { data: account } = await supabase
    .schema("fni")
    .from("store_provider_accounts")
    .select("id")
    .eq("store_id", storeId)
    .eq("provider", "TecAssured")
    .eq("active", true)
    .maybeSingle();

  if (!account) {
    return {
      properties: [],
      reason: "This store has no active TecAssured mapping, so nothing can be rated for it.",
    };
  }

  const cached = await readRateProperties(
    supabase,
    (account as { id: string }).id,
    vtype
  );

  if (!cached || cached.status !== "Cached") {
    return {
      properties: [],
      reason:
        `We have not yet asked TecAssured what it needs to rate a ${vtype} for ` +
        `this store. Press Refresh, or wait for tonight's refresh.`,
    };
  }

  return { properties: parseRequiredProperties(cached.properties).names, reason: null };
}

/** The sheet, plus everything the screen shows around it. */
async function sheetFor(supabase: SupabaseClient, s: Record<string, unknown>) {
  const { properties, reason } = await requiredFor(supabase, s.store_id as string, s.vehicle_type_code);
  const sheet = buildVerification(s as unknown as VerificationSource, properties);

  const { data: offerRow } = await supabase
    .schema("fni")
    .from("rated_offers")
    .select("state, product_count, out_of_date, rated_at, error_detail")
    .eq("session_id", s.id as string)
    .maybeSingle();

  const offer = (offerRow ?? null) as Record<string, unknown> | null;

  const [duplicates, contracts] = await Promise.all([
    duplicateVinSessions(supabase, s),
    liveContracts(supabase, s.id as string),
  ]);

  return {
    session: {
      id: s.id,
      deal_number: s.deal_number,
      stock_number: s.stock_number,
      status: s.status,
      is_test: s.is_test === true,
      vehicle: [s.unit_year, s.unit_make, s.unit_model]
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
        .join(" "),
      deal_type: dealTypeLabel(s.finance_type),
      vehicle_type_code: s.vehicle_type_code,
    },
    verification: {
      state: s.verification_state ?? "Needs Verification",
      verified_at: s.verified_at ?? null,
      verified_by: s.verified_by ?? null,
    },
    rating: offer
      ? {
          state: String(offer.state ?? "Rated"),
          product_count: offer.product_count ?? 0,
          out_of_date: offer.out_of_date === true,
          rated_at: offer.rated_at ?? null,
          detail: offer.state === "Failed" ? (offer.error_detail ?? null) : null,
        }
      : { state: "Pending", product_count: 0, out_of_date: false, rated_at: null, detail: null },
    vin_decode: s.vin_decode ?? null,
    vin_decode_at: s.vin_decode_at ?? null,
    // Case 3. A warning with the other deal numbers in it, and the ids so the
    // screen can link straight there rather than making staff go hunting.
    duplicate_vin: duplicates.length > 0
      ? {
          message: duplicateVinWarning(duplicates),
          sessions: duplicates.map((d) => ({
            id: d.id,
            deal_number: d.deal_number,
            status: d.status,
          })),
        }
      : null,
    // Case 1 and 2, seen from the staff side: paperwork that already exists.
    contracts: contracts.map((c) => ({
      contract_number: c.contract_number,
      provider_product_id: c.provider_product_id,
      product_name: c.product_name,
      status: c.status,
    })),
    submit_state: s.submit_state ?? "Idle",
    submit_detail: s.submit_detail ?? null,
    // Why nothing is required, when nothing is. Shown instead of a sheet that
    // looks complete because it is asking for nothing.
    not_ready_reason: reason,
    ...sheet,
  };
}

// ── save: the fields nothing else carries ─────────────────────────────────

async function save(
  supabase: SupabaseClient,
  s: Record<string, unknown>,
  entries: Record<string, unknown>
): Promise<Response> {
  const current = (s.vehicle_properties ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };

  const rejected: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(entries)) {
    const key = EDITABLE_KEYS.find((k) => k.toLowerCase() === rawKey.toLowerCase());
    if (!key) {
      // A CRM-owned field arriving here is either a stale form or someone
      // testing the endpoint. Refused by name rather than ignored, because
      // silently dropping an edit somebody made is worse than saying no.
      rejected.push(rawKey);
      continue;
    }
    const value = rawValue === null || rawValue === undefined ? "" : String(rawValue).trim();
    if (value === "") delete next[key];
    else next[key] = value;
  }

  if (rejected.length > 0) {
    return json(400, {
      error:
        `These fields are owned by the CRM and cannot be set here: ${rejected.join(", ")}. ` +
        `Correct them in CRM, then press Refresh.`,
      rejected,
    });
  }

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({ vehicle_properties: Object.keys(next).length > 0 ? next : null })
    .eq("id", s.id as string);

  if (error) return json(500, { error: error.message });

  const fresh = await loadSession(supabase, s.id as string);
  return json(200, await sheetFor(supabase, fresh!));
}

// ── decode: ask TecAssured what the VIN is ────────────────────────────────

async function decode(
  supabase: SupabaseClient,
  s: Record<string, unknown>
): Promise<Response> {
  const vin = typeof s.vin === "string" ? s.vin.trim() : "";
  if (vin === "") {
    return json(400, { error: "This deal has no VIN, so there is nothing to decode." });
  }

  let store;
  try {
    store = await createTecAssuredClient(s.store_id as string, supabase);
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }

  let decoded: unknown;
  try {
    decoded = await store.client.decodePowersports(vin);
  } catch (err) {
    return json(502, {
      error: `TecAssured could not decode ${vin}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // A refusal comes back as HTTP 200 with an error string, as everywhere else in
  // this API, and an unsupported VIN comes back empty. Neither is cached: a
  // cached empty decode would read on the screen as "asked and there is nothing",
  // which would send a staff member looking for a field to type when the real
  // answer is that the call needs trying again.
  const body = (decoded ?? {}) as Record<string, unknown>;
  const refusal = typeof body.error === "string" ? body.error.trim() : "";
  if (refusal !== "") {
    return json(400, { error: `TecAssured could not decode ${vin}: ${refusal}` });
  }
  if (Object.keys(body).length === 0) {
    return json(400, {
      error:
        `TecAssured returned nothing for ${vin}. This dealer code may not support ` +
        `VIN decoding, or the VIN is not one it recognises. Type the engine size instead.`,
    });
  }

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({ vin_decode: body, vin_decode_at: new Date().toISOString() })
    .eq("id", s.id as string);

  if (error) return json(500, { error: error.message });

  const fresh = await loadSession(supabase, s.id as string);
  return json(200, await sheetFor(supabase, fresh!));
}

// ── refresh: re-pull the deal from the CRM ────────────────────────────────

async function refresh(
  supabase: SupabaseClient,
  s: Record<string, unknown>
): Promise<Response> {
  const zohoId = typeof s.zoho_deal_id === "string" ? s.zoho_deal_id : null;
  if (!zohoId) {
    return json(400, {
      error:
        "This session has no CRM deal behind it, so there is nothing to refresh. " +
        "Test sessions are created without one.",
    });
  }

  let record;
  try {
    record = await getRecord("DocuRide", zohoId);
  } catch (err) {
    return json(502, {
      error: `Could not read the deal from CRM: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!record) {
    return json(404, { error: `CRM has no DocuRide record ${zohoId} any more.` });
  }

  const patch = crmRatingFields(record as unknown as Record<string, unknown>);

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update(patch)
    .eq("id", s.id as string);

  if (error) return json(500, { error: error.message });

  const fresh = (await loadSession(supabase, s.id as string))!;

  // ── Did the refresh move anything a rate depends on? ──────────────────
  //
  // Compared against the snapshot taken at verification, not against the row
  // before this update: the question is whether what the verifier approved is
  // still true, and a field that changed twice and came back is unchanged.
  const { properties } = await requiredFor(
    supabase,
    fresh.store_id as string,
    fresh.vehicle_type_code
  );
  const after = ratingInputs(
    buildVerification(fresh as unknown as VerificationSource, properties)
  );

  const snapshot = (fresh.verified_snapshot ?? null) as Record<string, unknown> | null;
  const before = (snapshot?.rating_inputs ?? null) as Record<string, string | null> | null;

  const changed = fresh.verification_state === "Verified" ? changedInputs(before, after) : [];

  if (changed.length > 0) {
    await supabase
      .schema("fni")
      .from("sessions")
      .update({
        verification_state: "Needs Verification",
        verified_at: null,
        verified_by: null,
        verified_snapshot: null,
      })
      .eq("id", fresh.id as string);

    // The quote is not deleted. It was a real price once and the record of it
    // matters; it just is not the answer to the current question any more.
    await supabase
      .schema("fni")
      .from("rated_offers")
      .update({ out_of_date: true })
      .eq("session_id", fresh.id as string);
  }

  const latest = (await loadSession(supabase, fresh.id as string))!;
  return json(200, {
    ...(await sheetFor(supabase, latest)),
    refreshed: true,
    changed_inputs: changed,
  });
}

// ── verify: the gate ──────────────────────────────────────────────────────

async function verify(
  supabase: SupabaseClient,
  s: Record<string, unknown>,
  verifiedBy: string
): Promise<Response> {
  const { properties, reason } = await requiredFor(
    supabase,
    s.store_id as string,
    s.vehicle_type_code
  );
  const sheet = buildVerification(s as unknown as VerificationSource, properties);

  // Checked here and not only on the screen. The button being enabled is not
  // evidence that it should have been: this endpoint is a POST like any other,
  // and the same computation that greys the button refuses the request.
  if (!sheet.ready) {
    return json(400, {
      error:
        reason ??
        `Not every field TecAssured asks for has a value yet: ` +
        `${sheet.missing.map((f) => f.label).join(", ")}.`,
      missing: sheet.missing.map((f) => ({ key: f.key, label: f.label })),
      unmapped_properties: sheet.unmapped_properties,
    });
  }

  const now = new Date().toISOString();

  // What the verifier saw, in full. This is the compliance record: it makes
  // "the price was built from bad data" a question with an answer.
  const snapshot = {
    verified_at: now,
    verified_by: verifiedBy,
    vehicle_type_code: s.vehicle_type_code ?? null,
    required_properties: properties,
    fields: sheet.fields.map((f) => ({
      key: f.key,
      label: f.label,
      value: f.value,
      source: f.source,
      provider_property: f.provider_property,
      required: f.required,
    })),
    rating_inputs: ratingInputs(sheet),
  };

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({
      verification_state: "Verified",
      verified_at: now,
      verified_by: verifiedBy,
      verified_snapshot: snapshot,
    })
    .eq("id", s.id as string);

  if (error) return json(500, { error: error.message });

  // A fresh verification supersedes whatever was rated under the old inputs.
  await supabase
    .schema("fni")
    .from("rated_offers")
    .update({ out_of_date: true })
    .eq("session_id", s.id as string);

  const fresh = (await loadSession(supabase, s.id as string))!;
  return json(200, {
    ...(await sheetFor(supabase, fresh)),
    // The caller runs the rating. Kept separate so a verification is recorded
    // even if the provider is having a bad afternoon: the person did their part
    // and the record should say so.
    verified: true,
  });
}

// ── Handler ───────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const url = new URL(req.url);

  const presented =
    req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  if (!secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }

  const supabase = admin();

  try {
    if (req.method === "GET") {
      const sessionId = url.searchParams.get("session_id");
      if (!sessionId || !UUID_RE.test(sessionId)) {
        return json(400, { error: "A well-formed session_id is required" });
      }
      const s = await loadSession(supabase, sessionId);
      if (!s) return json(404, { error: "Session not found" });
      return json(200, await sheetFor(supabase, s));
    }

    if (req.method !== "POST") return json(405, { error: "GET or POST only" });

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: "A JSON body is required" });
    }

    const sessionId = body.session_id;
    if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
      return json(400, { error: "A well-formed session_id is required" });
    }

    const s = await loadSession(supabase, sessionId);
    if (!s) return json(404, { error: "Session not found" });

    const action = String(body.action ?? "");

    if (action === "save") {
      const entries = body.entries;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        return json(400, { error: "entries must be an object" });
      }
      return await save(supabase, s, entries as Record<string, unknown>);
    }

    if (action === "decode") return await decode(supabase, s);
    if (action === "refresh") return await refresh(supabase, s);

    if (action === "verify") {
      const who = typeof body.verified_by === "string" ? body.verified_by.trim() : "";
      if (who === "") {
        // A verification with nobody's name on it is not a verification.
        return json(400, { error: "verified_by is required: a verification names a person." });
      }
      return await verify(supabase, s, who);
    }

    return json(400, { error: "action must be one of save, decode, refresh, verify" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-session-verify error:", message);
    return json(500, { error: message });
  }
});
