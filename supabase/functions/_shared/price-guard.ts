// _shared/price-guard.ts
//
// Submit sends exactly the customer's price (docs/multi-provider.md section
// 25). After the quote is cut down to what is being bought, every product's
// outgoing price (its rate's subTotal, options included) is compared with the
// price it should carry, to the cent. One that differs by a penny stops the
// submit before anything is sent, naming the product and both prices.
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

/** Every rate's outgoing price in the quote, in cents, by rate unique. */
export function outgoingPrices(quote: Record<string, unknown>): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const vehicles = Array.isArray(quote.vehicles) ? (quote.vehicles as Record<string, unknown>[]) : [];
  for (const v of vehicles) {
    for (const p of (Array.isArray(v.products) ? v.products : []) as Record<string, unknown>[]) {
      for (const r of (Array.isArray(p.rates) ? p.rates : []) as Record<string, unknown>[]) {
        const sub = r.subTotal as { amount?: unknown } | undefined;
        out.set(String(r.unique ?? ""), cents(sub?.amount));
      }
    }
  }
  return out;
}

export interface Expected {
  rate_unique: string;
  product_name: string;
  /** Dollars, as the selection holds them. */
  price: number;
}

/** One plain sentence per product whose outgoing price is not the expected one. Empty: all match. */
export function priceProblems(quote: Record<string, unknown>, expected: Expected[]): string[] {
  const sent = outgoingPrices(quote);
  const problems: string[] = [];
  for (const e of expected) {
    const want = cents(e.price);
    const got = sent.has(e.rate_unique) ? sent.get(e.rate_unique) ?? null : null;
    if (want === null) {
      problems.push(`${e.product_name} has no customer price, so it cannot be sent.`);
    } else if (got === null) {
      problems.push(`${e.product_name}: the contract would carry no price, but the customer's price is ${money(want)}.`);
    } else if (got !== want) {
      problems.push(`${e.product_name}: the contract would carry ${money(got)}, but the customer's price is ${money(want)}.`);
    }
  }
  return problems;
}
