// _shared/rate-probe.ts: what a rating probe may change, and how.
//
// A probe (fni-rate-probe, migration 0050) rates a deal on the provider's QA
// server with the request PS would send today, built by the same code
// (buildRateRequest), with some values changed:
//
//   properties  any form property, by its name ("make", "engine.ccs",
//               "service.drive"). It also sets the top-level field or fields
//               the API notes pair it with (_shared/TECASSURED_SHOP_API.md),
//               so both halves of the request say the same thing. A property
//               the request does not carry is added.
//   top         any top-level field ("serviceDrive", "saleType"), set to the
//               value given; null removes the field. A top-level value given
//               here wins over the one a property would set.
//
// Coded properties still go out as the provider's codes: the function codes
// the request after the properties and before the top-level values, which go
// out exactly as given (_shared/coded-values.ts).
//
// The first probes stored their overrides as a flat map of properties
// ({"new.used": "N"}); that form is still read.
//
// Pure, so a Node test can hold it.

/** Each form property and the top-level fields that carry the same value (API notes). */
export const PROPERTY_TOP: Readonly<Record<string, readonly string[]>> = {
  "vin": ["vin"],
  "year": ["year"],
  "make": ["make"],
  "model": ["model"],
  "odometer": ["odometer"],
  "price": ["vehiclePrice"],
  "new.used": ["purchaseType", "vehicleStatus"],
  "engine.ccs": ["displacement"],
  "fuel.type": ["fuelType"],
  "warranty": ["remainingMWM"],
  "finance.type": ["financeType"],
  "finance.amount": ["financeAmount"],
  "finance.apr": ["financeApr"],
  "finance.term": ["financeTerm"],
  "sale.date": ["saleDate", "vehiclePurchaseDate"],
  "inservice.date": ["inServiceDate"],
  "postal.code": ["customerPostalCode"],
};

export type TopValue = string | number | boolean | null;

export interface ProbeOverrides {
  properties: Record<string, string>;
  top: Record<string, TopValue>;
}

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_OVERRIDES = 20;

/** The overrides as stored, checked. Anything that could not be sent is refused, in plain English. */
export function parseProbeOverrides(raw: unknown): { overrides: ProbeOverrides } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "The probe names no values to change." };
  const r = raw as Record<string, unknown>;
  const shaped = "properties" in r || "top" in r;
  const props = (shaped ? r.properties ?? {} : r) as Record<string, unknown>;
  const top = (shaped ? r.top ?? {} : {}) as Record<string, unknown>;
  if (typeof props !== "object" || Array.isArray(props) || typeof top !== "object" || Array.isArray(top)) {
    return { error: "The probe's overrides are not in a form that could be sent." };
  }
  const out: ProbeOverrides = { properties: {}, top: {} };
  for (const [key, value] of Object.entries(props)) {
    if (!NAME.test(key)) return { error: `"${key}" is not a property name that could be sent.` };
    const v = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : null;
    if (v === null || v === "" || v.length > 100) return { error: `The probe's value for ${key} is not one that could be sent.` };
    out.properties[key] = v;
  }
  for (const [key, value] of Object.entries(top)) {
    if (!NAME.test(key)) return { error: `"${key}" is not a field name that could be sent.` };
    const ok = value === null || typeof value === "boolean" || typeof value === "number" || (typeof value === "string" && value.length <= 100);
    if (!ok) return { error: `The probe's value for ${key} is not one that could be sent.` };
    out.top[key] = value as TopValue;
  }
  const count = Object.keys(out.properties).length + Object.keys(out.top).length;
  if (count === 0) return { error: "The probe names no values to change." };
  if (count > MAX_OVERRIDES) return { error: `A probe may change at most ${MAX_OVERRIDES} values.` };
  return { overrides: out };
}

/**
 * The request with the probe's values in place. Properties first (each with
 * its paired top-level fields), then the top-level values, which win. The
 * request passed in is not changed.
 */
export function applyProbeOverrides(request: Record<string, unknown>, o: ProbeOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(request));
  const props = Array.isArray(out.properties) ? (out.properties as { name: string; value: string }[]) : [];
  for (const [key, value] of Object.entries(o.properties)) {
    const lower = key.toLowerCase();
    const at = props.filter((p) => String(p.name).toLowerCase() === lower);
    if (at.length === 0) props.push({ name: key, value });
    for (const p of at) p.value = value;
    for (const field of PROPERTY_TOP[lower] ?? []) out[field] = value;
  }
  out.properties = props;
  for (const [key, value] of Object.entries(o.top)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** The deal a probe must never touch. */
export const NEVER_PROBE_DEAL = "14957";

/** How long a requested probe may wait to be run. */
export const PROBE_WAIT_MINUTES = 10;
