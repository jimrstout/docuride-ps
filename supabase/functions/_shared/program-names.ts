// _shared/program-names.ts
//
// TecAssured's own name for each product version, so staff can tell twins
// apart: our "Priority Maintenance, Bronze" is three different TecAssured
// programs, "USED BRONZE UTV (Side by Side)", "USED BRONZE ON-ROAD NON-EU"
// and "USED BRONZE OFF-ROAD MC", and only the right one can be contracted
// for a vehicle. Shown to staff as a small label next to our name, in Admin
// and on Verify. Customers never see it.
//
// It is the product's label in a rated offer up to " - ", where TecAssured's
// own product line begins ("... - RIDERS ADVANTAGE PPM"). Pure, so a Node test
// holds it.

/** "USED BRONZE ON-ROAD NON-EU - RIDERS ADVANTAGE PPM" to "USED BRONZE ON-ROAD NON-EU". */
export function programName(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const head = label.split(" - ")[0].trim();
  return head === "" ? null : head;
}

/** Each product's program name in a TecAssured quote, by product unique. */
export function programNamesFromQuote(quote: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const q = (quote ?? {}) as Record<string, unknown>;
  const inner = (q.quote ?? q) as Record<string, unknown>;
  const vehicles = Array.isArray(inner.vehicles) ? inner.vehicles : [];
  for (const v of vehicles as Record<string, unknown>[]) {
    for (const p of (Array.isArray(v.products) ? v.products : []) as Record<string, unknown>[]) {
      const code = typeof p.unique === "string" ? p.unique : null;
      const name = programName(p.label ?? p.desc);
      if (code && name) out.set(code, name);
    }
  }
  return out;
}
