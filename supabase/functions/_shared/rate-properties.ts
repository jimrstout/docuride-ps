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
// The request builder that consumes this list lives in _shared/rate-request.ts.
// It is separate so that a function which only reads the cache does not bundle
// the builder, finance-basis.ts and money.ts along with it.
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
