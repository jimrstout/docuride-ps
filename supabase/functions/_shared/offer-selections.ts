// _shared/offer-selections.ts
//
// Reading a TecAssured quote, and flagging the customer's choices on it.
//
// ── The key names are read off a real quote, not guessed ─────────────────
// Confirmed 2026-09-25 against dealer 3-306, UTV. A product under
// quote.vehicles[].products[] carries:
//
//   label   the display name          NOT name / productName / description
//   ptype   the product type code     NOT productType / type / category
//   unique  the identifier            NOT productId / id
//
// `ident` exists and is "0" on every product, so it is not an identifier
// despite the name. `unique` is. Rates have their own `unique`, and money is
// always a { amount, currency } object.
//
// This lived inside fni-contract-submit and read the guessed names, which would
// have recorded product_name as "754_6" and product_type as "Unknown" for every
// contract. It is a module so that test/planner-offer-shape.test.mjs can run it
// against the real 78KB quote in test/fixtures/.

export interface ProductSelection {
  product_unique: string;
  rate_unique: string;
  option_uniques?: string[];
  retail_price: number;
}

/** What the quote says about a selected rate, gathered while flagging it. */
export interface ResolvedSelection {
  selection: ProductSelection;
  productName: string;
  productType: string;
  providerProductId: string;
  rateUniqueId: string;
  termMonths: number | null;
  termMiles: number | null;
  deductible: number | null;
  dealerCost: number | null;
  /** The provider's own markup, already baked into the rate's subTotal. */
  providerMarkup: number;
  optionCostTotal: number;
  /**
   * The most this rate may be sold for: dealerCost + providerMarkup + options.
   *
   * The provider enforces this and rejects the whole submit when it is
   * exceeded: "contract purchase price of $1,450.00 cannot be greater than the
   * maximum selling price of $1,094.00" (QA, 2026-09-25, dealer 3-306, rate
   * 2192 at dealerCost 1044 + providerMarkup 50).
   */
  offeredPrice: number | null;
  /** retail_price is above offeredPrice, so submitting would be refused. */
  overCap: boolean;
  rateSnapshot: unknown;
}

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function arrayAt(obj: Record<string, unknown>, key: string): unknown[] | null {
  return Array.isArray(obj[key]) ? (obj[key] as unknown[]) : null;
}

/** TecAssured money is { amount, currency }. Confirmed, not assumed. */
export function amountOf(money: unknown): number | null {
  if (!money || typeof money !== "object") return null;
  const m = money as Record<string, unknown>;
  return typeof m.amount === "number" ? m.amount : null;
}

function intOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

function numOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function str(v: unknown, fallback: string): string {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number") return String(v);
  return fallback;
}

/**
 * The products in a quote, wherever the envelope puts them.
 *
 * Real quotes nest them under quote.vehicles[].products[]. A bare
 * { vehicles: [...] } is also accepted because that is what fni-contract-submit
 * holds after it clones rated_offers.response_payload, which may or may not
 * carry the outer `quote` depending on what was stored.
 */
function vehiclesOf(offer: Record<string, unknown>): unknown[] {
  const direct = arrayAt(offer, "vehicles");
  if (direct) return direct;
  const quote = offer.quote;
  if (quote && typeof quote === "object") {
    return arrayAt(quote as Record<string, unknown>, "vehicles") ?? [];
  }
  return [];
}

/**
 * Flag the customer's choices on a quote, and gather what each selected rate
 * says about itself.
 *
 * Both jobs in one pass because they read the same nodes: doing them separately
 * means walking the quote twice and risking two different answers to "which
 * rate did they pick".
 */
export function applySelections(
  offer: Record<string, unknown>,
  selections: ProductSelection[]
): ResolvedSelection[] {
  const byProduct = new Map(selections.map((s) => [s.product_unique, s]));
  const selectedOptions = new Set(selections.flatMap((s) => s.option_uniques ?? []));
  const resolved: ResolvedSelection[] = [];

  for (const vehicle of vehiclesOf(offer)) {
    const products = arrayAt(vehicle as Record<string, unknown>, "products");
    if (!products) continue;

    for (const product of products) {
      const p = product as Record<string, unknown>;
      const productUnique = String(p.unique ?? "");
      const sel = byProduct.get(productUnique);

      p.selected = !!sel;

      const rates = arrayAt(p, "rates");
      if (!rates) continue;

      for (const rate of rates) {
        const r = rate as Record<string, unknown>;
        const rateUnique = String(r.unique ?? "");

        if (!sel || rateUnique !== sel.rate_unique) {
          r.selected = false;
          const options = arrayAt(r, "options");
          if (options) for (const o of options) (o as Record<string, unknown>).selected = false;
          continue;
        }

        r.selected = true;

        const dealerCost = amountOf(r.dealerCost);

        let optionCostTotal = 0;
        const options = arrayAt(r, "options");
        if (options) {
          for (const opt of options) {
            const o = opt as Record<string, unknown>;
            const optUnique = String(o.unique ?? "");
            // A mandatory option is not a choice, so it rides along whether or
            // not the customer ticked it. Real quotes do use mandatory: true --
            // the Service Drive surcharge on USED ATV/UTV CARE-SVC DRIVE.
            if (selectedOptions.has(optUnique) || o.mandatory === true) {
              o.selected = true;
              optionCostTotal += amountOf(o.dealerCost) ?? 0;
            } else {
              o.selected = false;
            }
          }
        }

        // Purchase price, as the provider computes it, is
        //   dealerCost + providerMarkup + systemMarkup + options
        // so our markup is what is left after the provider has taken its own.
        // Getting this wrong by the providerMarkup is how the first live submit
        // came back over the cap by exactly 50 dollars.
        const providerMarkup = amountOf((r.providerMarkup as Record<string, unknown> | undefined)?.adjustment) ?? 0;
        const offeredPrice = dealerCost === null ? null : dealerCost + providerMarkup + optionCostTotal;
        const overCap = offeredPrice !== null && sel.retail_price > offeredPrice;

        if (offeredPrice !== null && sel.retail_price > 0) {
          r.systemMarkup = {
            percentage: false,
            adjustment: { amount: sel.retail_price - offeredPrice, currency: "USD" },
          };
          r.subTotal = { amount: sel.retail_price, currency: "USD" };
        }

        resolved.push({
          selection: sel,
          // label, ptype and unique: the real names. desc is the shorter
          // description and is the fallback only because label is the one the
          // F&I user recognises on a menu.
          productName: str(p.label ?? p.desc, productUnique),
          productType: str(p.ptype, "Unknown"),
          // `unique` is the identifier. `ident` is "0" on every product in a
          // real quote, so it cannot be used here.
          providerProductId: productUnique,
          rateUniqueId: rateUnique,
          termMonths: intOf(r.termMonths),
          termMiles: intOf(r.termMiles),
          deductible: numOf(amountOf(r.dealerDeduct) ?? r.dealerDeduct),
          dealerCost,
          providerMarkup,
          optionCostTotal,
          offeredPrice,
          overCap,
          rateSnapshot: r,
        });
      }
    }
  }

  return resolved;
}


// ── Submit takes a pruned quote, not a flagged one ───────────────────────
//
// Section 7 of the Shop API doc: "To submit, send the object containing only
// the products, rates, and options & surcharges you wish to submit. Every
// product, rate, and option requested will be submitted."
//
// Flagging `selected` and sending all eleven products does not select one of
// them -- it asks for all of them. Against the QA server that request never
// came back at all: two submits hung, at 5 and at 55 seconds, while the same
// quote pruned to one product answered in under fifteen. So presence is the
// selector and the flags are decoration.

export interface SubmitQuote {
  quote: Record<string, unknown>;
  resolved: ResolvedSelection[];
}

/**
 * The quote cut down to exactly what is being bought.
 *
 * Runs applySelections first, on a copy, so the flags are still set the way the
 * documented example shows them (rate selected, product not) -- and then keeps
 * only the products and rates that were chosen, and only the options that ride
 * with them.
 */
export function buildSubmitQuote(
  offer: Record<string, unknown>,
  selections: ProductSelection[]
): SubmitQuote {
  const working = deepClone(offer);
  const resolved = applySelections(working, selections);

  const chosenRates = new Set(resolved.map((r) => r.rateUniqueId));
  const chosenProducts = new Set(resolved.map((r) => r.providerProductId));

  const vehicles = vehiclesOf(working).map((vehicle) => {
    const v = { ...(vehicle as Record<string, unknown>) };
    const products = (arrayAt(v, "products") ?? [])
      .map((p) => p as Record<string, unknown>)
      .filter((p) => chosenProducts.has(String(p.unique ?? "")))
      .map((p) => ({
        ...p,
        rates: (arrayAt(p, "rates") ?? [])
          .map((rt) => rt as Record<string, unknown>)
          .filter((rt) => chosenRates.has(String(rt.unique ?? "")))
          .map((rt) => ({
            ...rt,
            // Only the options that are actually going on the contract.
            options: (arrayAt(rt, "options") ?? [])
              .map((o) => o as Record<string, unknown>)
              .filter((o) => o.selected === true),
          })),
      }));
    v.products = products;
    return v;
  });

  // The envelope stays as rated -- ident, referenceNumber, buyerPostal and the
  // rest are what tie the submit back to the quote.
  const source = (working.quote ?? working) as Record<string, unknown>;
  const quote = { ...source, vehicles };

  return { quote, resolved };
}
