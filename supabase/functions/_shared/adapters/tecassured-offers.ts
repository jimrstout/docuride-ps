// _shared/adapters/tecassured-offers.ts
//
// A TecAssured quote as normalized offers: one per buyable rate.
//
// The reading of a real quote moved here from planner-offers.ts unchanged:
// products at quote.vehicles[].products[], rates under each product, money as
// { amount, currency }, the family from `ptype`. See planner-offers.ts for why
// eleven products are five decisions; groupOffers puts them back together.
//
// Pure, so a Node test can hold it against a recorded quote.

import type { NormalizedOffer, OfferProvider, SurchargeOption } from "../normalized-offer.ts";

// ── Reading the provider's values ────────────────────────────────────────

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

/** TecAssured money is { amount, currency }. Confirmed against a real quote. */
function amountOf(money: unknown): number | null {
  if (!money || typeof money !== "object") return null;
  return asNumber((money as Record<string, unknown>).amount);
}

function arrayAt(o: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(o[key]) ? (o[key] as unknown[]) : [];
}

function attributes(o: Record<string, unknown>): Record<string, unknown> {
  const a = o.attributes;
  return a && typeof a === "object" && !Array.isArray(a)
    ? (a as Record<string, unknown>)
    : {};
}

/** Products live at quote.vehicles[].products[]. A bare vehicles[] is accepted
 *  too, because rated_offers.response_payload may hold either. */
function productsIn(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;
  const root = (o.quote && typeof o.quote === "object" ? o.quote : o) as Record<string, unknown>;

  const out: Record<string, unknown>[] = [];
  for (const vehicle of arrayAt(root, "vehicles")) {
    if (!vehicle || typeof vehicle !== "object") continue;
    for (const p of arrayAt(vehicle as Record<string, unknown>, "products")) {
      if (p && typeof p === "object") out.push(p as Record<string, unknown>);
    }
  }
  return out;
}

function normalizeOptions(raw: unknown[]): SurchargeOption[] {
  return raw
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => ({
      code: asString(o.unique ?? o.code) ?? "",
      label: asString(o.label ?? o.desc) ?? "",
      cost_delta: amountOf(o.dealerCost) ?? 0,
      mandatory: o.mandatory === true,
      applied: o.selected === true,
    }))
    .filter((o) => o.code !== "" || o.label !== "");
}

/**
 * Every buyable rate in a quote, in the quote's own order.
 *
 * A product with no rates offers nothing and yields nothing. `ident` is "0" on
 * every product, so it is not an identifier despite the name; `unique` is.
 */
export function tecAssuredOffers(
  payload: unknown,
  provider: OfferProvider | null = null
): NormalizedOffer[] {
  const out: NormalizedOffer[] = [];

  for (const product of productsIn(payload)) {
    const code = asString(product.unique) ?? "";
    const name = asString(product.label ?? product.desc) ?? code;
    const family = asString(product.ptype) ?? "Unknown";

    for (const r of arrayAt(product, "rates")) {
      if (!r || typeof r !== "object") continue;
      const rate = r as Record<string, unknown>;
      const attrs = attributes(rate);
      const dealerCost = amountOf(rate.dealerCost);
      const markup =
        amountOf((rate.providerMarkup as Record<string, unknown> | undefined)?.adjustment) ?? 0;

      out.push({
        provider_id: provider?.id ?? null,
        provider_name: provider?.name ?? null,
        product_id: null,
        product_code: code,
        product_name: name,
        category: null,
        family_code: family,
        plan: null,
        term_months: asNumber(rate.termMonths),
        term_miles: asNumber(rate.termMiles),
        deductible: amountOf(rate.dealerDeduct),
        deductible_label: asString(attrs["deduct.code"]),
        disappearing_deductible: asString(attrs["deduct.type"]) === "DIS",
        dealer_cost: dealerCost,
        provider_markup: markup,
        suggested_retail: null,
        maximum_price: dealerCost === null ? null : dealerCost + markup,
        options: normalizeOptions(arrayAt(rate, "options")),
        eligibility_notes: [],
        rate_key: asString(rate.unique) ?? "",
        source: { product, rate },
      });
    }
  }
  return out;
}
