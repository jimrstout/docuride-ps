// _shared/rate-probe.ts: what a rating probe may change, and how.
//
// A probe (fni-rate-probe, migration 0050) rates a deal on the provider's QA
// server with the request PS would send today, built by the same code
// (buildRateRequest), with one or two values changed. Only these two may be:
//
//   new.used      the properties array entry, and the two top-level fields
//                 that carry the same value: purchaseType and vehicleStatus
//   finance.type  the properties array entry, and the top-level financeType
//
// Everything else in the request is exactly what a real rating sends, so a
// difference in the answer is down to the values changed and nothing else.
//
// Pure, so a Node test can hold it.

/** Each property a probe may change, and the top-level fields that carry it. */
export const PROBE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "new.used": ["purchaseType", "vehicleStatus"],
  "finance.type": ["financeType"],
};

export type ProbeOverrides = Record<string, string>;

/** The overrides as stored, checked. A key or value we would not send is refused, in plain English. */
export function parseProbeOverrides(raw: unknown): { overrides: ProbeOverrides } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "The probe names no values to change." };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { error: "The probe names no values to change." };
  const overrides: ProbeOverrides = {};
  for (const [key, value] of entries) {
    if (!(key in PROBE_FIELDS)) {
      return { error: `A probe may change only ${Object.keys(PROBE_FIELDS).join(" and ")}, not ${key}.` };
    }
    const v = typeof value === "string" ? value.trim() : "";
    if (v === "" || v.length > 20) return { error: `The probe's value for ${key} is not one that could be sent.` };
    overrides[key] = v;
  }
  return { overrides };
}

/**
 * The request with the probe's values in place: in the properties array (an
 * entry is added when the provider did not ask for that property) and in each
 * top-level field that carries it. The request passed in is not changed.
 */
export function applyProbeOverrides(request: Record<string, unknown>, overrides: ProbeOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(request));
  const props = Array.isArray(out.properties) ? (out.properties as { name: string; value: string }[]) : [];
  for (const [key, value] of Object.entries(overrides)) {
    const at = props.filter((p) => String(p.name).toLowerCase() === key);
    if (at.length === 0) props.push({ name: key, value });
    for (const p of at) p.value = value;
    for (const field of PROBE_FIELDS[key] ?? []) out[field] = value;
  }
  out.properties = props;
  return out;
}

/** The deal a probe must never touch. */
export const NEVER_PROBE_DEAL = "14957";

/** How long a requested probe may wait to be run. */
export const PROBE_WAIT_MINUTES = 10;
