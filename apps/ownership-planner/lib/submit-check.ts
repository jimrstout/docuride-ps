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

/** The reason Submit is disabled, or null when it may be pressed. */
export function submitBlock(sheet: {
  day?: { submit_problem: string | null } | null;
  rating: { out_of_date: boolean };
}): string | null {
  return sheet.day?.submit_problem ?? (sheet.rating.out_of_date ? RATING_OUT_OF_DATE : null);
}
