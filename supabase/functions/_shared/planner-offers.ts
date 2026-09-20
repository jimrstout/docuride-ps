// _shared/planner-offers.ts
//
// Normalizes a TecAssured Offer Format response into the shape the planner
// renders.
//
// IMPORTANT, and deliberately loud: the exact Offer Format is not yet confirmed.
// Credentials had not arrived as of 2026-09-17 and the documentation carries no
// usable test credentials, so the key names below are read tolerantly across the
// spellings TecAssured's REST conventions suggest. fni-rate-vehicle already
// counts products off either `products` or `productTypes`, which is the only
// direct evidence available.
//
// Every raw product object is carried through untouched on `raw`, so when live
// responses arrive the normalizer can be corrected without another round trip
// to the provider and without losing anything already stored.

export interface SurchargeOption {
  code: string;
  label: string;
  /** Added to dealer cost when the option applies. */
  cost_delta: number;
  /** True when the rated offer already applied it. */
  applied: boolean;
}

export interface NormalizedProduct {
  /** The product code. Written to selected_products.provider_product_id. */
  product_code: string;
  product_type: string;
  product_name: string;
  rate_unique_id: string | null;
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  dealer_cost: number | null;
  surcharge_options: SurchargeOption[];
  /** The provider's object, verbatim. */
  raw: Record<string, unknown>;
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  }
  return undefined;
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function normalizeSurcharges(raw: unknown): SurchargeOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      code:
        asString(pick(s, ["code", "surchargeCode", "id", "optionCode"])) ?? "",
      label:
        asString(pick(s, ["description", "name", "label", "surchargeName"])) ??
        "",
      cost_delta: asNumber(pick(s, ["cost", "amount", "price", "dealerCost"])) ?? 0,
      applied:
        pick(s, ["applied", "selected", "isApplied"]) === true ||
        pick(s, ["applied", "selected", "isApplied"]) === "true",
    }))
    .filter((s) => s.code !== "" || s.label !== "");
}

/**
 * Pull the product array out of whatever envelope the response uses.
 */
function productArray(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;

  for (const key of ["products", "productTypes", "offers", "rates"]) {
    const v = o[key];
    if (Array.isArray(v)) {
      return v.filter(
        (p): p is Record<string, unknown> => !!p && typeof p === "object"
      );
    }
  }

  // Some envelopes nest the offer one level down.
  for (const key of ["offer", "data", "result"]) {
    const v = o[key];
    if (v && typeof v === "object") {
      const inner = productArray(v);
      if (inner.length > 0) return inner;
    }
  }
  return [];
}

export function normalizeOffer(payload: unknown): NormalizedProduct[] {
  return productArray(payload).map((p) => {
    const code =
      asString(
        pick(p, [
          "productUnique",
          "productCode",
          "product_unique",
          "code",
          "productId",
          "id",
        ])
      ) ?? "";

    return {
      product_code: code,
      product_type:
        asString(pick(p, ["productType", "type", "category"])) ?? code,
      product_name:
        asString(pick(p, ["productName", "name", "description", "displayName"])) ??
        code,
      rate_unique_id: asString(
        pick(p, ["rateUnique", "rateUniqueId", "rateId", "uniqueId"])
      ),
      term_months: asNumber(pick(p, ["termMonths", "term", "months"])),
      term_miles: asNumber(pick(p, ["termMiles", "miles", "mileage"])),
      deductible: asNumber(pick(p, ["deductible", "deductibleAmount"])),
      dealer_cost: asNumber(
        pick(p, ["dealerCost", "cost", "netCost", "dealer_cost"])
      ),
      surcharge_options: normalizeSurcharges(
        pick(p, ["surcharges", "options", "surchargeOptions"])
      ),
      raw: p,
    };
  });
  // NOTE: products with an empty product_code are kept rather than dropped.
  // The caller reports them as unrenderable, because silently losing a product
  // the provider offered is worse than showing that something is wrong.
}
