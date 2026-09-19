// lib/dx1.ts — vehicle photo lookup by VIN.
//
// ─────────────────────────────────────────────────────────────────────────
// NOT YET WIRED, and deliberately not faked.
//
// The build spec says to reuse the extraction iRideStoreFront already performs
// on a DX1 inventory listing rather than writing a second one. That code is not
// in this repository, and no DX1 client exists here yet -- MIGRATION_PATH.md
// still lists `_shared/dms/dx1.ts` as work to be done.
//
// The spec also assumes a single DX1_API_KEY environment variable. That is not
// how this platform holds DX1 credentials: MIGRATION_PATH.md §102 puts them
// per-store in `stores.dms_config`, encrypted via Supabase Vault. A global key
// would be the wrong shape even if one existed.
//
// So `fetchPhotos` returns an empty result until the extraction method is
// carried over. Guessing at DX1's response shape would produce a route that
// looks finished and returns nothing real, which is worse than a route that
// says plainly that it is not connected yet. The empty path below is a genuine
// production path regardless -- a unit sold the day it arrived has no photos,
// and a trade unit may never get them -- so it is designed, not a stub.
// ─────────────────────────────────────────────────────────────────────────

import "server-only";

export interface PhotoResult {
  /** Image URLs, newest-listing-first. Empty means "looked up, none exist". */
  photos: string[];
  /** Set when the lookup could not run at all, as distinct from finding none. */
  unavailable_reason: string | null;
}

export async function fetchPhotos(vin: string | null): Promise<PhotoResult> {
  if (!vin) {
    return { photos: [], unavailable_reason: "No VIN on this session" };
  }

  // When the iRideStoreFront extraction lands, it goes here: resolve the
  // store's DX1 credentials, fetch the inventory listing for this VIN, and take
  // the first two or three images. Cache is handled by the caller.
  return {
    photos: [],
    unavailable_reason:
      "DX1 photo lookup is not connected yet (see lib/dx1.ts)",
  };
}
