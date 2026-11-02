// _shared/warranty-band.ts: a plan sold by remaining factory warranty.
//
// The provider offers some Mechanical Protection plans in bands of remaining
// factory warranty, one product per band, and returns every band whatever the
// deal's warranty: deal 15063, rated with 12 months remaining, came back with
// Premium Plus 1-12, 13-24 and 25-36 together. Its own descriptions say what
// the band is: "NEW ATV/UTV PREMIUM PLUS 13-24 Months Warranty Remaining".
//
// Only the band holding the deal's remaining warranty may appear anywhere: a
// band that does not is treated like a product not offered. The months are the
// ones the rating was made with (remainingMWM in its request), so the offers
// and the band always agree; changing the warranty on Details marks the rating
// out of date, and Rate again settles it.
//
// The band is read from the product's label ("... PREMIUM PLUS 13-24 - RIDERS
// ADVANTAGE ..."). The first band's description says "1-14 Months" while its
// label says 1-12; the labels do not overlap and the descriptions would, so
// the label decides.
//
// Pure, so a Node test can hold it.

import type { NormalizedFamily } from "./normalized-offer.ts";

export interface Band {
  from: number;
  to: number;
}

/**
 * The warranty band in a Mechanical Protection product's label, or null when
 * it has none. Only the part before the provider's suffix (" - RIDERS
 * ADVANTAGE ...") is read.
 */
export function warrantyBand(label: string | null | undefined, productType: string | null | undefined): Band | null {
  if (!label || String(productType ?? "").toUpperCase() !== "VSA") return null;
  const name = label.split(" - ")[0];
  const m = name.match(/\b(\d{1,3})\s*-\s*(\d{1,3})\s*$/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return from <= to ? { from, to } : null;
}

/** Does a band hold the months? Unknown months hold no band. */
export function bandHolds(band: Band, months: number | null): boolean {
  return months !== null && months >= band.from && months <= band.to;
}

/** The remaining factory warranty a TecAssured rating was made with, in months. */
export function ratedWarrantyMonths(request: unknown): number | null {
  const r = request as Record<string, unknown> | null;
  const raw = r?.remainingMWM;
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The families without any band that does not hold the months. */
export function withinWarrantyBand(families: NormalizedFamily[], months: number | null): NormalizedFamily[] {
  return families
    .map((f) => ({
      ...f,
      tiers: f.tiers.filter((t) => {
        const band = warrantyBand(t.product_name, t.product_type ?? f.family_code);
        return band === null || bandHolds(band, months);
      }),
    }))
    .filter((f) => f.tiers.length > 0);
}

/** Why Submit refuses a band that does not hold the rated months. Plain English. */
export function bandRefusal(name: string, band: Band, months: number | null): string {
  return (
    `${name} is for ${band.from} to ${band.to} months of factory warranty remaining, and this deal was rated with ` +
    `${months === null ? "no warranty months" : `${months}`}, so it cannot be sent.`
  );
}
