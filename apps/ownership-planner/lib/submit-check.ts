// lib/submit-check.ts: why Details would not let contracts be submitted yet.
//
// fni-contract-submit refuses on the same grounds before it sends anything
// (_shared/store-day.ts, _shared/sale-date.ts). This says why ahead of time,
// so the button is disabled with the reason beside it rather than pressed and
// refused. The Next build cannot import from supabase/functions, so the one
// sentence is mirrored here and test/renew-sale-date.test.mjs fails if they
// drift.
//
// No React and no Next imports, so a Node test can hold it.

export const RATING_OUT_OF_DATE =
  "The rating is out of date because something it was rated on has changed, such as the sale date. " +
  "Press Confirm and Continue on Details to rate the deal again before submitting.";

/**
 * On a test session on the QA server an out-of-date rating does not block
 * Submit (fni-contract-submit records that it was used); this is said instead,
 * beside the button and in the confirmation.
 */
export const STALE_TEST_NOTE = "The rating is out of date. This is a test session, so you can still submit.";

interface SubmitSheet {
  day?: { submit_problem: string | null } | null;
  rating: { out_of_date: boolean };
  /** test_at_maximum: a test session on the QA server, as the submit decides it. */
  contracts_panel?: { confirmation?: { test_at_maximum?: boolean } | null } | null;
}

/**
 * Why Submit is disabled (`block`), or what to say beside it when it is not
 * (`note`). The sale day is checked for every session. An out-of-date rating
 * blocks a real session and is only noted on a test session on the QA server.
 */
export function submitCheck(sheet: SubmitSheet): { block: string | null; note: string | null } {
  if (sheet.day?.submit_problem) return { block: sheet.day.submit_problem, note: null };
  if (!sheet.rating.out_of_date) return { block: null, note: null };
  return sheet.contracts_panel?.confirmation?.test_at_maximum === true
    ? { block: null, note: STALE_TEST_NOTE }
    : { block: RATING_OUT_OF_DATE, note: null };
}

/** The reason Submit is disabled, or null when it may be pressed. */
export function submitBlock(sheet: SubmitSheet): string | null {
  return submitCheck(sheet).block;
}
