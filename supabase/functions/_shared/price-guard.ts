// _shared/price-guard.ts
//
// Submit sends exactly what the customer chose (docs/multi-provider.md section
// 25). After the quote is cut down to what is being bought, and before the
// provider is called, every outgoing product is checked against the saved
// selection:
//
//   product  the quote carries exactly the selected products, each selected
//            rate under its own product, and nothing else
//   term     the outgoing rate's term in months is the one the customer chose
//   price    the outgoing price (the rate's subTotal, options included) is the
//            price it should carry, to the cent
//
// Any difference stops the submit before anything is sent, with a plain
// sentence naming the product, what was selected and what would go out.
//
// The price it should carry is the selection's customer price, which the
// save worked out on the server from the deal's prices (fni-session-save). A
// test session on the QA server is submitted at the provider's maximum by
// design (_shared/price-cap.ts), and is held to that instead.
//
// Pure, so a Node test can hold it.

export const PRICE_GUARD_EVENT = "Submit stopped: a price differs from the customer's price";

const cents = (n: unknown): number | null => {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
};

const money = (c: number) =>
  `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One outgoing rate: its product, price in cents and term. */
export interface OutgoingRate {
  product_unique: string;
  product_label: string;
  cents: number | null;
  term_months: number | null;
}

/** Every outgoing rate in the quote, by rate unique. */
export function outgoingRates(quote: Record<string, unknown>): Map<string, OutgoingRate> {
  const out = new Map<string, OutgoingRate>();
  const vehicles = Array.isArray(quote.vehicles) ? (quote.vehicles as Record<string, unknown>[]) : [];
  for (const v of vehicles) {
    for (const p of (Array.isArray(v.products) ? v.products : []) as Record<string, unknown>[]) {
      for (const r of (Array.isArray(p.rates) ? p.rates : []) as Record<string, unknown>[]) {
        const sub = r.subTotal as { amount?: unknown } | undefined;
        const term = Number(r.termMonths);
        out.set(String(r.unique ?? ""), {
          product_unique: String(p.unique ?? ""),
          product_label: String(p.label ?? p.unique ?? ""),
          cents: cents(sub?.amount),
          term_months: Number.isFinite(term) && r.termMonths !== null && r.termMonths !== undefined ? term : null,
        });
      }
    }
  }
  return out;
}

/** Every rate's outgoing price in the quote, in cents, by rate unique. */
export function outgoingPrices(quote: Record<string, unknown>): Map<string, number | null> {
  return new Map([...outgoingRates(quote)].map(([k, r]) => [k, r.cents]));
}

export interface Expected {
  rate_unique: string;
  product_name: string;
  /** Dollars, as the selection holds them. */
  price: number;
  /** The selected product's unique. When given, the outgoing rate must sit under it. */
  product_unique?: string;
  /** The term the customer chose, in months. When given, the outgoing rate must carry it. */
  term_months?: number | null;
}

/** "48 months", "1 month". */
const months = (n: number) => (n === 1 ? "1 month" : `${n} months`);

/**
 * One plain sentence per product that would not go out as selected: a
 * different product, term or price, a selected product missing, or a product
 * nobody selected. Empty: everything matches.
 */
export function priceProblems(quote: Record<string, unknown>, expected: Expected[]): string[] {
  const sent = outgoingRates(quote);
  const problems: string[] = [];
  for (const e of expected) {
    const want = cents(e.price);
    const out = sent.get(e.rate_unique) ?? null;
    if (out && e.product_unique !== undefined && out.product_unique !== e.product_unique) {
      problems.push(`${e.product_name}: the contract would be for a different product (${out.product_label}) than the one selected.`);
      continue;
    }
    if (out && e.term_months !== undefined && e.term_months !== null && out.term_months !== e.term_months) {
      problems.push(
        `${e.product_name}: the contract would carry ${out.term_months === null ? "no term" : months(out.term_months)}, ` +
        `but the customer chose ${months(e.term_months)}.`
      );
      continue;
    }
    const got = out?.cents ?? null;
    if (want === null) {
      problems.push(`${e.product_name} has no customer price, so it cannot be sent.`);
    } else if (got === null) {
      problems.push(`${e.product_name}: the contract would carry no price, but the customer's price is ${money(want)}.`);
    } else if (got !== want) {
      problems.push(`${e.product_name}: the contract would carry ${money(got)}, but the customer's price is ${money(want)}.`);
    }
  }
  // Anything going out that nobody selected.
  const wanted = new Set(expected.map((e) => e.rate_unique));
  for (const [unique, out] of sent) {
    if (!wanted.has(unique)) problems.push(`${out.product_label} would go out on the contract, but it was not selected.`);
  }
  return problems;
}
