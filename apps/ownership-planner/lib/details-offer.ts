// lib/details-offer.ts: Details after Rate again, from the function's answer.
//
// A rating changes only some of Details: the rating line and its time, the
// product count, the notices about what the fresh offer took away, the menu's
// hidden slots, the selections Rate again could not keep, the menu's columns,
// the contracts panel and its Submit confirmation, and the session's status.
// fni-rate-vehicle answers Rate again with exactly those, built by the same
// function Details loads with (supabase/functions/_shared/details-offer.ts).
// This puts them over the sheet already on the screen, so Details updates in
// place without reading the whole deal again (fni-session-verify) or running
// the DX1 check again (fni-dx1-check): neither depends on the rating.
//
// Pure, so a Node test can hold it.

import type { VerifySheet } from "./types";

/** The keys of the sheet a rating changes, besides the session's status. Kept equal to the Edge Function's list. */
export const OFFER_KEYS = [
  "rating",
  "rating_differences",
  "menu_columns",
  "unplaced_offers",
  "rating_notices",
  "hidden_slots",
  "contracts_panel",
] as const;

/** What fni-rate-vehicle's Rate again answer carries for Details. */
export type OfferDetails = Pick<VerifySheet, (typeof OFFER_KEYS)[number]> & {
  session_status: VerifySheet["session"]["status"];
};

/** The sheet on the screen, with what the rating changed put over it. Nothing else changes. */
export function mergeOfferDetails(sheet: VerifySheet, d: OfferDetails): VerifySheet {
  const out: VerifySheet = { ...sheet, session: { ...sheet.session, status: d.session_status } };
  for (const key of OFFER_KEYS) {
    (out as unknown as Record<string, unknown>)[key] = (d as unknown as Record<string, unknown>)[key];
  }
  return out;
}

/** A well-formed answer: every key present. Anything less and the page reloads as before. */
export function isOfferDetails(v: unknown): v is OfferDetails {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return "session_status" in o && OFFER_KEYS.every((k) => k in o) && !!o.rating && typeof o.rating === "object";
}
