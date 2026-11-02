// lib/nav-busy.ts: the shared names for the page-change busy state.
//
// No React and no "use client", so the tests read them too.

/** Where a newly drawn tab says so, for the tab that opened it. */
export const DRAWN_CHANNEL = "docuride-page-drawn";

/** Never wait longer than this for the next page. */
export const NAV_GIVE_UP_MS = 45_000;

/** What a link says while its page is on the way. */
export const OPENING = "Opening...";
