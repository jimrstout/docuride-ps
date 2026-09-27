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
import { financeFigures, type FinanceSource } from "./finance-basis.ts";

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
  // The corrected finance columns. Optional so a caller written before they
  // existed still typechecks; absent reads as absent, not as zero. See
  // _shared/finance-basis.ts for why these and not the three above.
  interest_rate?: number | null;
  finance_term_total?: number | null;
  tila_amount_financed?: number | null;
  lienholder_name?: string | null;
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

/**
 * The three finance numbers, resolved together.
 *
 * TecAssured asks for finance.amount, finance.apr and finance.term on every
 * vehicle type it rates, cash deal or not, and a DocuRide cash deal has none of
 * them: apr and finance_term are null. Sent as nulls they counted as missing,
 * and the rate was refused before it was ever attempted. That is what stopped
 * deal 14132 from rating.
 *
 * A cash purchase finances zero dollars over zero months at zero percent. That
 * is not a placeholder standing in for an unknown, it is the arithmetic of the
 * deal, so it is sent as fact.
 *
 * The amount is forced to zero too, and that part matters most. fni.sessions
 * can still be carrying an amount_financed from an earlier draft of the deal --
 * 14132 has 19,764.64 on it with no lienholder -- and passing that through would
 * tell the provider a cash buyer financed nearly twenty thousand dollars. The
 * same reasoning already governs resolvePaymentBasis in _shared/money.ts: on a
 * cash deal the financing columns are leftovers, not facts.
 */
function financeFields(source: RateSource): {
  type: string | null;
  amount: string | null;
  apr: string | null;
  term: string | null;
} {
  const type = financeType(source.finance_type);

  if (type === "None") {
    return { type, amount: "0", apr: "0", term: "0" };
  }

  // ── Resolved, not read straight off apr and finance_term ───────────────────
  // Those two are only filled when TILA has been calculated. On deal 13759 --
  // financed, Roadrunner Financial, 60 months at 6.99% -- both were null, so
  // finance.apr and finance.term went up missing and TecAssured refused the
  // rate for a deal whose terms the CRM knew perfectly well. The resolver reads
  // the columns SPEC_CORRECTIONS.md §1 proved carry the real figures, and it is
  // the same call the Verify screen makes, so the gate and the request cannot
  // disagree about whether this deal has a term.
  const fig = financeFigures(source as unknown as FinanceSource);

  return {
    type,
    amount: text(source.amount_financed),
    apr: fig.ratePercent === null ? null : String(fig.ratePercent),
    term: fig.termMonths === null ? null : String(fig.termMonths),
  };
}

/**
 * Fuel type, defaulting to gasoline.
 *
 * No Zoho field carries it -- Sold_1_Fuel_Type does not exist on the record --
 * and every unit in this dealer group's deal history is gasoline. Section 6.5
 * allows G, E and D, so an electric unit is expressible and a staff member can
 * set it through vehicle_properties; it is the DEFAULT that is gasoline, not the
 * only value.
 *
 * Defaulting is defensible here in a way it would not be for engine size. Fuel
 * type is an eligibility input rather than a price input, the wrong answer is
 * visible on the contract, and the alternative was refusing to rate every deal
 * in the system over a field nobody can currently fill in.
 */
const DEFAULT_FUEL_TYPE = "Gas";

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
  const fin = financeFields(source);

  return {
    "vin": text(source.vin),
    "year": text(source.unit_year),
    "make": text(source.unit_make),
    "model": text(source.unit_model),
    "new.used": newUsed(source.condition),
    "odometer": text(source.odometer),
    "price": text(source.sale_price),
    "finance.type": fin.type,
    "finance.amount": fin.amount,
    "finance.apr": fin.apr,
    "finance.term": fin.term,
    "sale.date": isoDate(source.sale_date),
    "inservice.date": isoDate(source.in_service_date) ?? isoDate(source.sale_date),
    "postal.code": text(source.buyer_zip),
    "fuel.type": DEFAULT_FUEL_TYPE,
    //
    // Deliberately absent, because no field anywhere carries them and a guess
    // would be a guess at somebody's price: engine.ccs and warranty. Both come
    // from sessions.vehicle_properties, entered by staff, and a rate is refused
    // without them rather than sent with a number we invented.
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
  const fuel = fuelCode(supplied.get("fuel.type") ?? supplied.get("fueltype") ?? DEFAULT_FUEL_TYPE);

  const fin = financeFields(source);

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

    // The same three values the properties array carries, from the same
    // resolution, so the two halves of the request cannot disagree about
    // whether this deal is financed.
    financeAmount: fin.amount,
    financeTerm: fin.term,
    financeType: fin.type,
    financeApr: fin.apr,

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
