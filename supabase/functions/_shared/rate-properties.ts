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
  buyer_city: string | null;
  buyer_state: string | null;
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

/**
 * TecAssured's own finance-type values, read off a real quote.
 *
 * The quote echoes the form schema for finance.type, and its allowed values are
 * exactly: None, Loan, Balloon, Lease (keys N, F, B, L). "Purchase" is not one
 * of them, and "Cash" is not either -- a cash deal is None.
 *
 * We previously sent "Purchase" for a financed deal. It rated, but only because
 * finance.type is required: false for UTV and every product on the QA dealer
 * came back financeable: false, so the value was very likely ignored rather
 * than understood. On a financeable product that would misrate silently, which
 * is the kind of thing that is only ever found in someone's payment.
 *
 * Balloon has no DocuRide counterpart yet: fni.sessions.finance_type is only
 * ever Cash or Loan today. When one appears, add it here and to the session.
 */
function financeType(v: string | null): string | null {
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === "cash" || lower === "none") return "None";
  if (lower === "loan" || lower === "finance" || lower === "purchase") return "Loan";
  if (lower === "balloon") return "Balloon";
  if (lower === "lease") return "Lease";
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

// ─── The request ─────────────────────────────────────────────────────
//
// Proved against the QA server on 2026-09-25: dealer 3-306, the Ranger test
// VIN, 11 products and 41 rates back with real dealer costs. What made it work
// was sending BOTH halves.
//
// ── Why both ──────────────────────────────────────────────────────────
// The documented /rate (section 5) takes named top-level camelCase fields.
// /rate/requiredproperties returns dotted lowercase keys -- and section 7.7
// names those "Form Properties", "the programmatic key (e.g. finance.type,
// new.used)". They are the schema for the data-entry form, not the wire format.
//
// So the two are near-complete duplicates of each other under different names:
// price/vehiclePrice, engine.ccs/displacement, Warranty/remainingMWM,
// postal.code/customerPostalCode, and so on. Sending only the properties array
// failed; sending only the camelCase fields failed with " Missing
// displacement." because displacement was in the array rather than at the top.
// Sending both rates.
//
// The array is still what requiredproperties asked for, because that is what
// says which data a given dealer needs for a given vehicle type -- and it is
// the thing that decides whether we have enough to rate at all.

/** Section 6.5. The only documented values; "Gas" is not one of them. */
const FUEL_TYPE_CODES: Record<string, string> = {
  g: "G", gas: "G", gasoline: "G", petrol: "G",
  e: "E", electric: "E", ev: "E",
  d: "D", diesel: "D",
};

function fuelCode(v: unknown): string | null {
  const raw = text(v);
  return raw ? FUEL_TYPE_CODES[raw.toLowerCase()] ?? null : null;
}

export interface RateRequestOptions {
  dealerCode: string;
  vtype: string;
  /** Defaults to today. The date the actuarial tables are pulled for. */
  rateDate?: string;
}

export interface BuiltRateRequest {
  request: Record<string, unknown>;
  missing: RequiredProperty[];
}

/**
 * The full /rate body: documented top-level fields plus the properties array.
 *
 * A field is omitted when its value is null rather than sent empty -- section
 * 6.2 marks most of them optional, and an empty string is not the same as
 * absent. `missing` still reports only what requiredproperties asked for and we
 * could not answer, because that list is what decides whether a rate is
 * possible; a null optional top-level field is not a blocker.
 */
export function buildRateRequest(
  required: RequiredProperty[],
  source: RateSource,
  opts: RateRequestOptions
): BuiltRateRequest {
  const built = buildRateProperties(required, source);

  const supplied = new Map<string, unknown>();
  const extra = source.vehicle_properties;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra)) supplied.set(k.toLowerCase(), v);
  }

  const today = new Date().toISOString().split("T")[0];
  const saleDate = isoDate(source.sale_date) ?? today;
  const inService = isoDate(source.in_service_date) ?? saleDate;
  const status = newUsed(source.condition);

  // Engine size and warranty months live under different names in the two
  // formats. One stored value feeds both; the lookup is case-insensitive so a
  // stored `warranty` answers `Warranty` here as it does in the array.
  const displacement = text(supplied.get("engine.ccs")) ?? text(supplied.get("displacement"));
  const warrantyMonths = text(supplied.get("warranty")) ?? text(supplied.get("remainingmwm"));
  const fuel = fuelCode(supplied.get("fuel.type") ?? supplied.get("fueltype"));

  const request: Record<string, unknown> = {
    dealerCode: opts.dealerCode,
    vtype: opts.vtype,
    productType: "All",
    rateDate: opts.rateDate ?? today,

    vin: text(source.vin),
    year: text(source.unit_year),
    make: text(source.unit_make),
    model: text(source.unit_model),
    odometer: text(source.odometer),
    vehiclePrice: text(source.sale_price),

    // Section 6.2 calls vehicleStatus a duplicate of purchaseType. Both are
    // marked Required, so both are sent from the one value rather than one
    // being inferred.
    purchaseType: status,
    vehicleStatus: status,

    vehiclePurchaseDate: saleDate,
    saleDate,
    inServiceDate: inService,

    financeAmount: text(source.amount_financed),
    financeTerm: text(source.finance_term),
    financeType: financeType(source.finance_type),
    financeApr: text(source.apr),

    customerCity: text(source.buyer_city),
    customerState: text(source.buyer_state),
    customerCountry: "US",
    customerPostalCode: text(source.buyer_zip),

    displacement,
    fuelType: fuel,
    remainingMWM: warrantyMonths,
  };

  for (const [k, v] of Object.entries(request)) {
    if (v === null || v === undefined) delete request[k];
  }

  request.properties = built.properties;

  return { request, missing: built.missing };
}
