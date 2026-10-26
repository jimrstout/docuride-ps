// _shared/rating-summary.ts
//
// What a session's rating attempts add up to. See docs/multi-provider.md,
// section 5.
//
// A session has one fni.rated_offers row per provider. The latest rating names
// the providers it rated in sessions.rated_provider_ids; only their rows make
// the menu and the status. A provider a later rating no longer needed (the deal
// now matches a different template) keeps its row as a record and is ignored.
//
// Pure, so the planner page, Verify and the save all read one answer.

import { groupOffers, type NormalizedFamily, type NormalizedOffer } from "./normalized-offer.ts";
import { normalizeOffer } from "./planner-offers.ts";

/** A rated_offers row with its provider embedded. */
export interface RatingRow {
  provider_id: string;
  state: string;
  product_count: number;
  rated_at: string | null;
  error_detail: string | null;
  out_of_date: boolean;
  response_payload: unknown;
  /** Why the last re-rate failed, when these offers were kept through it. */
  last_failure_detail?: string | null;
  provider: { id: string; name: string; kind: string; adapter: string | null } | null;
}

/** The rows of the latest rating. Before the first, every row there is. */
export function currentRows(rows: RatingRow[], ratedProviderIds: string[] | null | undefined): RatingRow[] {
  const ids = ratedProviderIds ?? [];
  return ids.length === 0 ? rows : rows.filter((r) => ids.includes(r.provider_id));
}

/**
 * The offers a row recorded, as families.
 *
 * A TecAssured row holds the provider's quote, read the way it always was. Any
 * other provider's row holds the normalized offers themselves, a snapshot of
 * the sheet as it was when the deal was rated, so a sheet republished later
 * cannot change a price a customer has already been shown.
 */
export function familiesFromRow(row: RatingRow): NormalizedFamily[] {
  if (row.state !== "Rated" || row.out_of_date || row.response_payload == null) return [];
  const provider = row.provider ? { id: row.provider.id, name: row.provider.name } : null;
  if (row.provider?.adapter === "TecAssured") return normalizeOffer(row.response_payload, provider);
  const offers = (row.response_payload as { offers?: NormalizedOffer[] }).offers;
  return Array.isArray(offers) ? groupOffers(offers) : [];
}

/** Every current provider's offered families, together. */
export function familiesFromRows(rows: RatingRow[]): NormalizedFamily[] {
  return rows.flatMap(familiesFromRow).sort(
    (a, b) =>
      a.family_code.localeCompare(b.family_code) ||
      (a.provider_name ?? "").localeCompare(b.provider_name ?? "")
  );
}

/** One provider's line on Verify, in plain English. */
export function providerLine(row: RatingRow): string {
  const name = row.provider?.name ?? "A provider";
  const kept = row.state === "Rated" && row.last_failure_detail
    ? ` The last re-rate failed (${row.last_failure_detail.replace(/[.\s]+$/, "")}), so these are the earlier offers, kept.`
    : "";
  if (row.out_of_date) return `${name}: Out of date. Rate again.${kept}`;
  if (row.state === "Rated") {
    return `${name}: Rated, ${row.product_count} ${row.product_count === 1 ? "product" : "products"}.${kept}`;
  }
  if (row.state === "Not Offered") return `${name}: Nothing offered for this unit.`;
  const detail = (row.error_detail ?? "Rating failed.").replace(` for ${name}.`, ".");
  return `${name}: ${detail}`;
}

export interface RatingSummary {
  /**
   * Rated when any provider rated. Not Offered only when every provider said
   * so, because that is the one state a customer is told "not offered" for.
   * Anything else is Failed: neutral copy for the customer, reasons for staff.
   */
  state: "Rated" | "Not Offered" | "Failed" | "Pending";
  product_count: number;
  /** Any provider of the latest rating is out of date. */
  out_of_date: boolean;
  rated_at: string | null;
  /** The non-rated providers' lines, for the one-line status. */
  detail: string | null;
  providers: {
    provider_id: string;
    name: string;
    state: string;
    product_count: number;
    out_of_date: boolean;
    line: string;
  }[];
}

export function ratingSummary(rows: RatingRow[]): RatingSummary {
  if (rows.length === 0) {
    return { state: "Pending", product_count: 0, out_of_date: false, rated_at: null, detail: null, providers: [] };
  }
  const sorted = [...rows].sort((a, b) => (a.provider?.name ?? "").localeCompare(b.provider?.name ?? ""));
  const rated = sorted.filter((r) => r.state === "Rated");
  const state = rated.length > 0 ? "Rated"
    : sorted.every((r) => r.state === "Not Offered") ? "Not Offered"
    : "Failed";
  const others = sorted.filter((r) => r.state !== "Rated");
  const stamps = sorted.map((r) => r.rated_at).filter((t): t is string => !!t).sort();

  return {
    state,
    product_count: rated.reduce((n, r) => n + (r.product_count ?? 0), 0),
    out_of_date: sorted.some((r) => r.out_of_date),
    rated_at: stamps[stamps.length - 1] ?? null,
    detail: others.length > 0 ? others.map(providerLine).join(" ") : null,
    providers: sorted.map((r) => ({
      provider_id: r.provider_id,
      name: r.provider?.name ?? "A provider",
      state: r.state,
      product_count: r.product_count ?? 0,
      out_of_date: r.out_of_date,
      line: providerLine(r),
    })),
  };
}
