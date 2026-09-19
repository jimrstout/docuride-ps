// _shared/planner-catalog.ts
//
// Matching rated products to their plain-language copy, and — the point of this
// file — telling the two failure modes apart.
//
// A rated product that is not shown to the customer is one of two very
// different things:
//
//   copy_pending  A catalog row exists and its copy is not finished. The
//                 product is withheld on purpose: the catalog is what stops a
//                 plan being sold off a blank description. Nobody needs paging.
//
//   unmatched     The product was rated and nothing in fni.product_catalog
//                 matches it. Nobody decided that. It is a join failure.
//
// Until these were separated both ended the same way, as a product silently
// absent from the customer's list. That is how a store stops offering GAP for a
// month with nobody noticing, and it is the likely shape of trouble on the day
// TecAssured credentials arrive: the join runs on productUnique, and the seeded
// mock matches only because the same person authored both sides of it.
//
// Telling them apart REQUIRES the deliberate case to be a row that exists with
// its copy unwritten. Leaving a known-but-unwritten product out of the catalog
// entirely makes it indistinguishable from one we failed to recognise — so an
// absent row means exactly one thing, and it means something is wrong.

export interface CatalogRow {
  product_code: string;
  display_name?: string | null;
  store_id?: string | null;
  is_presentable?: boolean;
}

export interface RatedProductRef {
  product_code: string;
  product_name: string;
}

export interface CatalogCoverage {
  /** How many rated products were considered. */
  offered: number;
  /** How many found a catalog row, presentable or not. */
  matched: number;
  /** Row exists, copy unfinished. A decision. */
  copy_pending: { product_code: string; display_name: string }[];
  /** No row at all. A defect. */
  unmatched: { product_code: string; product_name: string }[];
}

/**
 * Index catalog rows by product code, letting a store row beat a tenant-wide
 * one for the same code.
 */
export function indexCatalog(rows: CatalogRow[]): Map<string, CatalogRow> {
  const byCode = new Map<string, CatalogRow>();
  for (const row of rows) {
    const code = row.product_code;
    if (!code) continue;
    const existing = byCode.get(code);
    if (!existing || (existing.store_id === null && row.store_id !== null)) {
      byCode.set(code, row);
    }
  }
  return byCode;
}

export function classifyCoverage(
  products: RatedProductRef[],
  byCode: Map<string, CatalogRow>
): CatalogCoverage {
  const copy_pending: CatalogCoverage["copy_pending"] = [];
  const unmatched: CatalogCoverage["unmatched"] = [];
  let matched = 0;

  for (const p of products) {
    // A product carrying no identifier at all cannot be matched, priced against
    // a band, or written to selected_products. Same class of fault, reported
    // the same way rather than quietly skipped.
    if (!p.product_code) {
      unmatched.push({ product_code: "", product_name: p.product_name });
      continue;
    }

    const row = byCode.get(p.product_code);
    if (!row) {
      unmatched.push({ product_code: p.product_code, product_name: p.product_name });
      continue;
    }

    matched++;
    if (row.is_presentable !== true) {
      copy_pending.push({
        product_code: p.product_code,
        display_name: row.display_name || p.product_code,
      });
    }
  }

  return { offered: products.length, matched, copy_pending, unmatched };
}

/**
 * The log line for a failed join. Error level on purpose: a withheld product is
 * a decision, an unmatched one is a defect, and the customer it happens to is
 * the last person equipped to notice.
 */
export function joinFailureReport(
  sessionId: string,
  storeId: string | null,
  coverage: CatalogCoverage,
  offeredCodes: string[]
): string {
  return JSON.stringify({
    session_id: sessionId,
    store_id: storeId,
    unmatched_codes: coverage.unmatched.map((u) => u.product_code),
    offered_codes: offeredCodes,
    detail:
      "These products were rated but have no row in fni.product_catalog. " +
      "Either the catalog is missing them, or provider product codes do not " +
      "match product_catalog.product_code.",
  });
}
