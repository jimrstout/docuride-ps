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
//   POST { session_id, action }          -> save | decode | refresh
//                                           | discard_edits | verify
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
  editableKeys,
  editTargetFor,
  labelFor,
  ratingInputs,
  type VerificationSource,
} from "../_shared/verification.ts";
import {
  applyStaffEdits,
  castForColumn,
  parseStaffEdits,
  type StaffEdits,
} from "../_shared/staff-edits.ts";
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

// The fixed three-key allowlist that used to live here is gone. Which fields may
// be edited is now a property of the sheet's own specs, and it depends on the
// deal: the three finance figures close on a cash deal. editableKeys() is the one
// answer, and the screen greys the same fields this endpoint refuses.

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
  // The staff layer over the CRM's figures. Migration 0016.
  "staff_edits",
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
  const edits = parseStaffEdits(s.staff_edits);

  // The required-properties lookup has to use the EDITED vehicle type, not the
  // CRM one. That is the whole point of making it editable: a Defender whose
  // body type nobody has fixed in Zoho is corrected to UTV here, and the very
  // next thing that must change is which seventeen fields TecAssured is asking
  // for. Looking it up from the CRM value would leave the screen checking the
  // wrong list against the right vehicle.
  const edited = applyStaffEdits(s, edits, editTargetFor);

  const { properties, reason } = await requiredFor(
    supabase,
    s.store_id as string,
    edited.vehicle_type_code
  );
  const sheet = buildVerification(s as unknown as VerificationSource, properties, edits);

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
      deal_type: dealTypeLabel(edited.finance_type),
      vehicle_type_code: edited.vehicle_type_code,
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

// ── save: any field that feeds a rate ─────────────────────────────────────

async function save(
  supabase: SupabaseClient,
  s: Record<string, unknown>,
  entries: Record<string, unknown>,
  editedBy: string
): Promise<Response> {
  const edits = parseStaffEdits(s.staff_edits);

  // What each field says with no staff layer at all. This is where an edit's
  // "original" comes from, and taking it from the unedited sheet rather than from
  // the row is what makes it read the way the screen showed it: "$24,000.00",
  // not 24000. requiredProperties is irrelevant to resolving a value, so the
  // lookup is skipped.
  const base = buildVerification(s as unknown as VerificationSource, []);
  const baseByKey = new Map(base.fields.map((f) => [f.key, f]));

  // Editability depends on the deal as it now stands, edits included: changing
  // the deal type from Cash to Finance in the same save that sets the APR has to
  // let the APR through.
  const provisional = applyStaffEdits(s, edits, editTargetFor) as unknown as VerificationSource;
  const allowed = editableKeys(provisional);

  const rejected: string[] = [];
  const unreadable: { key: string; label: string; value: string }[] = [];
  const now = new Date().toISOString();

  for (const [rawKey, rawValue] of Object.entries(entries)) {
    const key = allowed.find((k) => k.toLowerCase() === rawKey.toLowerCase());
    if (!key) {
      // Either a field nothing may edit -- Deal # and Stock # -- or one closed by
      // the deal as it stands, such as APR on a cash deal. Refused by name rather
      // than ignored, because silently dropping somebody's correction is worse
      // than saying no to it.
      rejected.push(rawKey);
      continue;
    }

    const value = rawValue === null || rawValue === undefined ? "" : String(rawValue).trim();

    // Cleared means "go back to what the source says", which is the only way out
    // of an edit other than Discard.
    if (value === "") {
      delete edits[key];
      continue;
    }

    // Refused before it is stored, not after. A price that cannot be read as a
    // number would sit in the layer doing nothing while the screen implied it had
    // taken effect.
    const target = editTargetFor(key);
    if (target && target.kind === "column" && castForColumn(target, value) === null) {
      unreadable.push({ key, label: labelFor(key), value });
      continue;
    }

    const wasEdited = edits[key];
    const baseField = baseByKey.get(key);

    edits[key] = {
      value,
      // An existing edit keeps its first original. Editing a price twice still
      // records what the CRM said, not what the last person typed.
      original: wasEdited ? wasEdited.original : (baseField?.value ?? null),
      original_source: wasEdited
        ? wasEdited.original_source
        : (baseField?.source ?? "Missing"),
      edited_by: editedBy,
      edited_at: now,
    };
  }

  if (rejected.length > 0) {
    return json(400, {
      error:
        `These fields cannot be edited here: ${rejected.map(labelFor).join(", ")}. ` +
        `Deal # and Stock # identify the deal, and the finance figures are fixed ` +
        `at zero on a cash deal.`,
      rejected,
    });
  }

  if (unreadable.length > 0) {
    return json(400, {
      error:
        `These values could not be read: ` +
        `${unreadable.map((u) => `${u.label} ("${u.value}")`).join(", ")}. ` +
        `Enter a plain number for money, a whole number for months and miles, ` +
        `and a date as YYYY-MM-DD.`,
      unreadable,
    });
  }

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({ staff_edits: Object.keys(edits).length > 0 ? edits : null })
    .eq("id", s.id as string);

  if (error) return json(500, { error: error.message });

  const fresh = await loadSession(supabase, s.id as string);
  return json(200, await sheetFor(supabase, fresh!));
}

// ── discard: put the CRM's figures back ───────────────────────────────────

/**
 * "Discard my edits and reload from CRM."
 *
 * Drops every edit to a field the CRM carries, then re-pulls the deal. The
 * fields CRM does NOT carry -- engine size, factory warranty, fuel type -- are
 * kept, because there is nothing to reload them from and throwing them away
 * would leave the session unrateable for no reason at all. The screen says so
 * under the button rather than leaving it as a surprise.
 */
async function discardEdits(
  supabase: SupabaseClient,
  s: Record<string, unknown>
): Promise<Response> {
  const edits = parseStaffEdits(s.staff_edits);
  const base = buildVerification(s as unknown as VerificationSource, []);
  const crmOwned = new Set(base.fields.filter((f) => f.in_crm).map((f) => f.key));

  const kept: StaffEdits = {};
  const discarded: string[] = [];
  for (const [key, edit] of Object.entries(edits)) {
    if (crmOwned.has(key)) discarded.push(labelFor(key));
    else kept[key] = edit;
  }

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update({ staff_edits: Object.keys(kept).length > 0 ? kept : null })
    .eq("id", s.id as string);

  if (error) return json(500, { error: error.message });

  const fresh = (await loadSession(supabase, s.id as string))!;

  // Then reload, which is the other half of what the button says. A session with
  // no CRM deal behind it has nothing to reload from, and that is not a failure:
  // the discard still happened.
  if (typeof fresh.zoho_deal_id === "string" && fresh.zoho_deal_id !== "") {
    return await refresh(supabase, fresh, discarded);
  }

  return json(200, {
    ...(await sheetFor(supabase, fresh)),
    discarded_edits: discarded,
    refreshed: false,
  });
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
  s: Record<string, unknown>,
  discarded: string[] | null = null
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

  // Only the CRM's own columns. sessions.staff_edits is not in this patch and is
  // not cleared anywhere in this function, which is how a refresh keeps staff
  // edits: the layer sits above the columns being rewritten. Discard is the only
  // thing that drops them.
  const patch = crmRatingFields(record as unknown as Record<string, unknown>);

  const { error } = await supabase
    .schema("fni")
    .from("sessions")
    .update(patch)
    .eq("id", s.id as string);

  if (error) return json(500, { error: error.message });

  const fresh = (await loadSession(supabase, s.id as string))!;
  const freshEdits = parseStaffEdits(fresh.staff_edits);

  // ── Did the refresh move anything a rate depends on? ──────────────────
  //
  // Compared against the snapshot taken at verification, not against the row
  // before this update: the question is whether what the verifier approved is
  // still true, and a field that changed twice and came back is unchanged.
  const { properties } = await requiredFor(
    supabase,
    fresh.store_id as string,
    (applyStaffEdits(fresh, freshEdits, editTargetFor)).vehicle_type_code
  );
  // With the edits applied, because the question is whether what the verifier
  // approved is still what would be sent, and what would be sent includes their
  // corrections. A CRM field that moved underneath an edit changes nothing the
  // provider sees, so it must not un-verify the session; it shows up in the
  // mismatch warning instead, which is where it belongs.
  const after = ratingInputs(
    buildVerification(fresh as unknown as VerificationSource, properties, freshEdits)
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
    // Present only when this refresh came from Discard.
    discarded_edits: discarded ?? undefined,
  });
}

// ── verify: the gate ──────────────────────────────────────────────────────

async function verify(
  supabase: SupabaseClient,
  s: Record<string, unknown>,
  verifiedBy: string
): Promise<Response> {
  const edits = parseStaffEdits(s.staff_edits);
  const edited = applyStaffEdits(s, edits, editTargetFor);
  const { properties, reason } = await requiredFor(
    supabase,
    s.store_id as string,
    edited.vehicle_type_code
  );
  const sheet = buildVerification(s as unknown as VerificationSource, properties, edits);

  // Checked here and not only on the screen. The button being enabled is not
  // evidence that it should have been: this endpoint is a POST like any other,
  // and the same computation that greys the button refuses the request.
  if (!sheet.ready) {
    return json(400, {
      error: sheet.invalid.length > 0
        ? `These edits could not be read, so they are not in force: ` +
          `${sheet.invalid.map((f) => f.label).join(", ")}. Correct them before verifying.`
        : reason ??
          `Not every field TecAssured asks for has a value yet: ` +
          `${sheet.missing.map((f) => f.label).join(", ")}.`,
      missing: sheet.missing.map((f) => ({ key: f.key, label: f.label })),
      invalid: sheet.invalid.map((f) => ({ key: f.key, label: f.label })),
      unmapped_properties: sheet.unmapped_properties,
    });
  }

  // A field that disagrees with the CRM deal does NOT stop a verification. Jim's
  // rule, and the right one: the person at the desk can see the machine and the
  // paperwork, so their figure is the one to rate on. What it does do is stay on
  // the record and on the screen until the deal is brought into line.

  const now = new Date().toISOString();

  // What the verifier saw, in full. This is the compliance record: it makes
  // "the price was built from bad data" a question with an answer.
  const snapshot = {
    verified_at: now,
    verified_by: verifiedBy,
    // The vehicle type as RATED, which on a corrected deal is not the CRM's.
    // Recording the CRM value here would make the snapshot disagree with the
    // required_properties list beside it, and the list is the one that was used.
    vehicle_type_code: edited.vehicle_type_code ?? null,
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

    // Who changed what, from what, to what, and when. The compliance half of
    // making CRM fields editable: a price that was rated on a staff correction
    // must be answerable months later, by name.
    staff_edits: sheet.edited.map((f) => ({
      key: f.key,
      label: f.label,
      from: f.original,
      from_source: f.original_source,
      to: f.value,
      edited_by: f.edited_by,
      edited_at: f.edited_at,
      in_crm: f.in_crm,
      differs_from_crm: f.differs_from_crm,
    })),
    // What the CRM deal disagreed with at the moment this was verified.
    crm_mismatches: sheet.crm_mismatches,
    crm_warning: sheet.crm_warning,
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
      // An edit with nobody's name on it is not a record of anything, and these
      // edits can now move a price. Same rule as verify.
      const who = typeof body.edited_by === "string" ? body.edited_by.trim() : "";
      if (who === "") {
        return json(400, { error: "edited_by is required: an edit names a person." });
      }
      return await save(supabase, s, entries as Record<string, unknown>, who);
    }

    if (action === "decode") return await decode(supabase, s);
    if (action === "refresh") return await refresh(supabase, s);
    if (action === "discard_edits") return await discardEdits(supabase, s);

    if (action === "verify") {
      const who = typeof body.verified_by === "string" ? body.verified_by.trim() : "";
      if (who === "") {
        // A verification with nobody's name on it is not a verification.
        return json(400, { error: "verified_by is required: a verification names a person." });
      }
      return await verify(supabase, s, who);
    }

    return json(400, {
      error: "action must be one of save, decode, refresh, discard_edits, verify",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-session-verify error:", message);
    return json(500, { error: message });
  }
});
