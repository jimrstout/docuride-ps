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

// ── The sheet in a verify action's reply (fni-session-verify POST) ───────
// Every action fni-session-verify takes (Verify, Save changes, Discard, the
// buyer, co-buyer and lienholder, coverage levels, Refresh from CRM) answers
// with the whole sheet, built by sheetFor(), the same function Details loads
// with (GET), from the session as it stands after the action. Two things
// differ from a reload, and neither is shown:
//   - the reply carries a few words about the action beside the sheet
//     (REPLY_ONLY_KEYS); they are dropped;
//   - a reload reads the sale date fresh from the CRM as the page loads, and
//     the sheet says whether it could (day.sale_date_fresh, day.sale_date_problem).
//     An action makes no such read, so those two are kept from the sheet on
//     the screen, whose load did.

/** Keys a verify action's reply carries beside the sheet. */
export const REPLY_ONLY_KEYS = ["verified", "changed_inputs", "discarded_edits", "refreshed"] as const;

/** The reply is a whole sheet for this deal. */
function isSheetFor(v: unknown, sessionId: string): v is VerifySheet {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const session = o.session as { id?: unknown } | undefined;
  return !!session && session.id === sessionId && Array.isArray(o.fields) && !!o.verification && !!o.rating && !!o.day;
}

/** The sheet in a verify action's reply, as a reload draws it; null when the reply is not one. */
export function sheetFromReply(reply: unknown, screen: VerifySheet): VerifySheet | null {
  if (!isSheetFor(reply, screen.session.id)) return null;
  const out = { ...(reply as unknown as Record<string, unknown>) };
  for (const key of REPLY_ONLY_KEYS) delete out[key];
  const sheet = out as unknown as VerifySheet;
  const day = { ...sheet.day } as Record<string, unknown>;
  const loadedDay = (screen.day ?? {}) as Record<string, unknown>;
  for (const key of ["sale_date_fresh", "sale_date_problem"]) {
    if (key in loadedDay) day[key] = loadedDay[key];
    else delete day[key];
  }
  return { ...sheet, day: day as unknown as VerifySheet["day"] };
}

/** A well-formed answer: every key present. Anything less and the page reloads as before. */
export function isOfferDetails(v: unknown): v is OfferDetails {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return "session_status" in o && OFFER_KEYS.every((k) => k in o) && !!o.rating && typeof o.rating === "object";
}
