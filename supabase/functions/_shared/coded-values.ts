// _shared/coded-values.ts: the provider's codes for the fields it codes.
//
// The provider's form defines a code for each choice in three fields:
//
//   new.used      N New, U Used
//   finance.type  N None, F Loan, B Balloon, L Lease
//   fuel.type     G Gasoline, E Electric, D Diesel
//
// PS sent the labels ("New", "Loan"), and the provider ignored them. Probes on
// deal 15063 (fni.rate_probes, 2026-11-02): with new.used "N" the New programs
// came back, where every rating before had only Used ones; with finance.type
// "F" GAP came back, and with "Loan" it did not.
//
// So the request carries the code, in the properties array and in each
// top-level field that carries the same value. What PS stores and shows stays
// the word: the session says "New" and "Loan", and so do the screens.
//
// ── Where the codes come from ───────────────────────────────────────────
// The form comes back inside every quote (quote.vehicles[0].form.properties,
// each coded field with extension.values) and is served nowhere else. Each
// rating keeps what it saw (store_rate_properties.form_codes, migration 0051),
// and the next rating for that account and vehicle type reads it. Until a
// quote for a vehicle type has been seen, the codes the provider documents are
// used. Year, make and model carry an empty placeholder list in the form: they
// are free text, not coded.
//
// A word with no code in the list stops the rating with a plain-English
// message naming the field, rather than sending something the provider would
// silently ignore, which is exactly how New programs and GAP went missing.
//
// Pure, so a Node test can hold it.

export interface Code {
  key: string;
  value: string;
}

/** Coded fields by provider property name, lowercase. */
export type FormCodes = Record<string, Code[]>;

/** Each coded field: what staff call it, and the top-level fields that carry the same value. */
export const CODED_FIELDS: Readonly<Record<string, { label: string; top: readonly string[] }>> = {
  "new.used": { label: "New or Used", top: ["purchaseType", "vehicleStatus"] },
  "finance.type": { label: "Deal type", top: ["financeType"] },
  "fuel.type": { label: "Fuel type", top: ["fuelType"] },
};

/** The codes the provider documents, used until its form has been seen for a vehicle type. */
export const DOCUMENTED_CODES: FormCodes = {
  "new.used": [{ key: "N", value: "New" }, { key: "U", value: "Used" }],
  "finance.type": [
    { key: "N", value: "None" }, { key: "F", value: "Loan" }, { key: "B", value: "Balloon" }, { key: "L", value: "Lease" },
  ],
  "fuel.type": [{ key: "G", value: "Gasoline" }, { key: "E", value: "Electric" }, { key: "D", value: "Diesel" }],
};

/**
 * The coded fields a quote's form states. A field whose list has no real key
 * (year, make and model carry one empty placeholder) is not coded. Null when
 * the quote carries no form.
 */
export function formCodesFromQuote(response: unknown): FormCodes | null {
  const props = (response as { quote?: { vehicles?: { form?: { properties?: unknown } }[] } } | null)
    ?.quote?.vehicles?.[0]?.form?.properties;
  if (!Array.isArray(props)) return null;
  const out: FormCodes = {};
  for (const p of props as Record<string, unknown>[]) {
    const name = typeof p?.property === "string" ? p.property.toLowerCase() : null;
    const values = (p?.extension as { values?: unknown } | undefined)?.values;
    if (!name || !Array.isArray(values)) continue;
    const codes = (values as Record<string, unknown>[])
      .map((v) => ({ key: String(v?.key ?? "").trim(), value: String(v?.value ?? "").trim() }))
      .filter((v) => v.key !== "");
    if (codes.length > 0) out[name] = codes;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** "Loan" to "F" in that list. A value that is already one of the codes stays as it is. Null when neither. */
export function codeFor(codes: Code[], word: string): string | null {
  const w = word.trim().toLowerCase();
  return codes.find((c) => c.value.toLowerCase() === w)?.key ?? codes.find((c) => c.key.toLowerCase() === w)?.key ?? null;
}

/** The codes for a field: the form's when it stated them, else the documented ones. */
function codesFor(field: string, form: FormCodes | null | undefined): Code[] {
  return form?.[field] ?? DOCUMENTED_CODES[field] ?? [];
}

/** The message when a word has no code. Plain English, naming the field. */
export function noCodeMessage(field: string, word: string): string {
  const label = CODED_FIELDS[field]?.label ?? field;
  return (
    `Your provider has no code for ${label} "${word}", so rating was stopped rather than sending a value ` +
    `it would ignore. Check ${label} on Verify.`
  );
}

/**
 * The request with every coded field sent as the provider's code, in the
 * properties array and in each top-level field that carries it. The request
 * passed in is not changed.
 */
export function codeRequest(
  request: Record<string, unknown>,
  form: FormCodes | null | undefined,
): { request: Record<string, unknown> } | { problem: string } {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(request));
  const props = Array.isArray(out.properties) ? (out.properties as { name: string; value: string }[]) : [];
  for (const [field, { top }] of Object.entries(CODED_FIELDS)) {
    const codes = codesFor(field, form);
    for (const p of props.filter((x) => String(x.name).toLowerCase() === field)) {
      const code = codeFor(codes, String(p.value));
      if (code === null) return { problem: noCodeMessage(field, String(p.value)) };
      p.value = code;
    }
    for (const t of top) {
      const v = out[t];
      if (v === undefined || v === null) continue;
      const code = codeFor(codes, String(v));
      if (code === null) return { problem: noCodeMessage(field, String(v)) };
      out[t] = code;
    }
  }
  if (Array.isArray(out.properties)) out.properties = props;
  return { request: out };
}
