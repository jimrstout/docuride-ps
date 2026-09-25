// _shared/rate-properties.ts
//
// Turning /rate/requiredproperties into a rate request.
//
// ── The shape of the thing ──────────────────────────────────────────────
// TecAssured answers with a list of properties, each with a name, a
// description and a type:
//
//   {"properties":[{"name":"engine.ccs","description":"Engine CCs","type":"STRING"},
//                  {"name":"finance.amount","description":"Finance Amount","type":"DECIMAL"}, ...]}
//
// The names are dotted and lowercase, and the set differs by vehicle type and
// by dealer. The rate request is built from exactly this list -- one entry per
// name the server asked for, nothing else.
//
// ── Casing is theirs, not ours ──────────────────────────────────────────
// TecAssured returns `warranty` for MCYC and ATV and `Warranty` for UTV, BIKE
// and AUTO. Observed directly on 2026-09-25, same dealer, same call, different
// vtype. Nothing here corrects it or normalises it: the name is echoed back
// exactly as given, and values are looked up case-insensitively so that one
// stored `warranty` satisfies both spellings. Encoding the exceptions in a
// table would mean a code change the next time they add a vehicle type.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface RequiredProperty {
  name: string;
  description?: string;
  type?: string;
}

export interface ParsedProperties {
  properties: RequiredProperty[];
  /** Names in the server's own order and casing. */
  names: string[];
}

/** A cached answer for one store, one vehicle type. */
export interface RatePropertyCache {
  id: string;
  store_provider_account_id: string;
  vtype: string;
  status: "Cached" | "Unavailable";
  properties: unknown;
  property_names: string[];
  cached_at: string | null;
  error_message: string | null;
}

/**
 * Pull the property list out of whatever shape came back.
 *
 * A bare array and a { properties: [...] } wrapper are both accepted because
 * the server has been seen to use the wrapper and nothing guarantees it always
 * will. An entry with no usable name is dropped rather than sent as "".
 */
export function parseRequiredProperties(response: unknown): ParsedProperties {
  const raw = Array.isArray(response)
    ? response
    : response && typeof response === "object" &&
        Array.isArray((response as Record<string, unknown>).properties)
      ? ((response as Record<string, unknown>).properties as unknown[])
      : [];

  const properties: RequiredProperty[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (name === "") continue;
    properties.push({
      name,
      description: typeof e.description === "string" ? e.description : undefined,
      type: typeof e.type === "string" ? e.type : undefined,
    });
  }

  return { properties, names: properties.map((p) => p.name) };
}

// ─── The cache ───────────────────────────────────────────────────────────

export async function readRateProperties(
  supabase: SupabaseClient,
  accountId: string,
  vtype: string
): Promise<RatePropertyCache | null> {
  const { data, error } = await supabase
    .schema("fni")
    .from("store_rate_properties")
    .select("*")
    .eq("store_provider_account_id", accountId)
    .eq("vtype", vtype)
    .maybeSingle();

  if (error) throw new Error(`Failed to read cached rate properties: ${error.message}`);
  return (data as unknown as RatePropertyCache) ?? null;
}

/**
 * Record what a dealer said about a vehicle type.
 *
 * An empty answer is stored as "Unavailable" rather than as an empty Cached
 * row, because "this dealer does not sell UTVs" and "nobody has asked yet" are
 * different states and only one of them is worth retrying on demand.
 */
export async function writeRateProperties(
  supabase: SupabaseClient,
  accountId: string,
  vtype: string,
  response: unknown,
  errorMessage: string | null = null
): Promise<ParsedProperties> {
  const parsed = parseRequiredProperties(response);
  const now = new Date().toISOString();

  const { error } = await supabase
    .schema("fni")
    .from("store_rate_properties")
    .upsert(
      {
        store_provider_account_id: accountId,
        vtype,
        status: parsed.names.length > 0 ? "Cached" : "Unavailable",
        properties: response ?? null,
        property_names: parsed.names,
        cached_at: now,
        error_message: errorMessage,
        updated_at: now,
      },
      { onConflict: "store_provider_account_id,vtype" }
    );

  if (error) throw new Error(`Failed to cache rate properties: ${error.message}`);
  return parsed;
}

// ─── Building the request ────────────────────────────────────────────────

/** The session fields a rate request can be built from. */
export interface RateSource {
  vin: string | null;
  unit_year: number | null;
  unit_make: string | null;
  unit_model: string | null;
  condition: string | null;
  odometer: number | null;
  sale_price: number | null;
  amount_financed: number | null;
  apr: number | null;
  finance_term: number | null;
  finance_type: string | null;
  sale_date: string | null;
  in_service_date: string | null;
  buyer_zip: string | null;
  vehicle_properties: Record<string, unknown> | null;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Loan -> Purchase is TecAssured's word for the same thing. */
function financeType(v: string | null): string | null {
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === "loan") return "Purchase";
  if (lower === "lease") return "Lease";
  if (lower === "cash") return "Cash";
  return null;
}

/** New or Used, which is what new.used wants. */
function newUsed(condition: string | null): string | null {
  if (!condition) return null;
  const lower = condition.toLowerCase();
  if (lower === "used" || lower === "pre-owned") return "Used";
  if (lower === "new") return "New";
  return null;
}

/**
 * What the session knows, keyed by the LOWERCASED property name.
 *
 * Lowercased on purpose: it is what lets one entry answer both `warranty` and
 * `Warranty` without either spelling appearing here.
 */
function fromSession(source: RateSource): Record<string, string | null> {
  return {
    "vin": text(source.vin),
    "year": text(source.unit_year),
    "make": text(source.unit_make),
    "model": text(source.unit_model),
    "new.used": newUsed(source.condition),
    "odometer": text(source.odometer),
    "price": text(source.sale_price),
    "finance.type": financeType(source.finance_type),
    "finance.amount": text(source.amount_financed),
    "finance.apr": text(source.apr),
    "finance.term": text(source.finance_term),
    "sale.date": isoDate(source.sale_date),
    "inservice.date": isoDate(source.in_service_date) ?? isoDate(source.sale_date),
    "postal.code": text(source.buyer_zip),
    //
    // Deliberately absent, because no Zoho field carries them and inventing a
    // value would be inventing a rate: engine.ccs, fuel.type, warranty. They
    // come from sessions.vehicle_properties, set by the F&I user.
  };
}

export interface BuiltProperties {
  properties: { name: string; value: string }[];
  /** Asked for and not supplied. A rate must not be sent while this is non-empty. */
  missing: RequiredProperty[];
}

/**
 * Build the properties array for a rate request.
 *
 * One entry per name the server asked for, in its order, spelled its way. A
 * name we cannot answer is collected rather than omitted silently: a rate built
 * from a partial request is a rate for a different vehicle.
 */
export function buildRateProperties(
  required: RequiredProperty[],
  source: RateSource
): BuiltProperties {
  const session = fromSession(source);

  // Everything the user supplied, indexed case-insensitively so that a stored
  // `warranty` satisfies a requested `Warranty`.
  const supplied = new Map<string, unknown>();
  const extra = source.vehicle_properties;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra)) supplied.set(k.toLowerCase(), v);
  }

  const properties: { name: string; value: string }[] = [];
  const missing: RequiredProperty[] = [];

  for (const req of required) {
    const key = req.name.toLowerCase();

    // The user's value wins: it is the correction, and the session's is the
    // default it is correcting.
    const value = text(supplied.get(key)) ?? session[key] ?? null;

    if (value === null) {
      missing.push(req);
      continue;
    }
    properties.push({ name: req.name, value });
  }

  return { properties, missing };
}
