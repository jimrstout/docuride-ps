// _shared/rate-timing.ts: how long each step of a rating takes.
//
// A rate in PS takes noticeably longer than in iTap (2 to 3 seconds there).
// To see where the time goes, fni-rate-vehicle marks each step as it finishes
// and keeps the marks in the "Rated again" event's detail, under "timing":
//
//   steps   [{ step, ms }]: milliseconds since the request was received,
//           in the order the steps finished
//   facts   plain values about the run, under their own key: provider_login
//           (cached, fresh or failed), provider_login_retried, response_bytes,
//           rate_lines, crm_sale_date, selections_compared
//
// Measuring only. Nothing here changes what a rating does. Never holds a
// credential, a token or a buyer's details: only step names, numbers and
// short words.
//
// Pure, so a Node test can hold it.

export interface TimingStep {
  step: string;
  /** Milliseconds since the request was received, rounded. */
  ms: number;
}

export interface TimingDetail {
  steps: TimingStep[];
  /** The longest gap between two marks, and the step that ended it. */
  slowest: { step: string; ms: number } | null;
  total_ms: number;
  facts: Record<string, string | number | boolean | null>;
}

export class RateTiming {
  private readonly now: () => number;
  private readonly start: number;
  private readonly steps: TimingStep[] = [];
  private readonly facts: Record<string, string | number | boolean | null> = {};

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.start = now();
  }

  /** The step that has just finished. */
  mark(step: string): void {
    this.steps.push({ step, ms: Math.round(this.now() - this.start) });
  }

  /** A plain fact about the run: a word or a number, never a secret. */
  note(key: string, value: string | number | boolean | null): void {
    this.facts[key] = value;
  }

  /** What goes into the event, with the slowest step worked out. */
  detail(): TimingDetail {
    let slowest: { step: string; ms: number } | null = null;
    let prev = 0;
    for (const s of this.steps) {
      const took = s.ms - prev;
      if (slowest === null || took > slowest.ms) slowest = { step: s.step, ms: took };
      prev = s.ms;
    }
    return {
      steps: [...this.steps],
      slowest,
      total_ms: Math.round(this.now() - this.start),
      facts: { ...this.facts },
    };
  }
}

/** Every rate line in a quote: the rates under every product of every vehicle. */
export function rateLineCount(response: unknown): number {
  const root = (response as { quote?: unknown } | null)?.quote ?? response;
  const vehicles = (root as { vehicles?: unknown } | null)?.vehicles;
  if (!Array.isArray(vehicles)) return 0;
  let n = 0;
  for (const v of vehicles) {
    const products = (v as { products?: unknown } | null)?.products;
    if (!Array.isArray(products)) continue;
    for (const p of products) {
      const rates = (p as { rates?: unknown } | null)?.rates;
      if (Array.isArray(rates)) n += rates.length;
    }
  }
  return n;
}

/** The response's size in bytes, as compact JSON (the provider's own spacing is not kept). */
export function responseBytes(response: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(response) ?? "").length;
  } catch {
    return 0;
  }
}
