// lib/session-pages.ts: how the Sessions list splits into pages.
//
// The list shows as many sessions as fit the screen without scrolling, and
// pages through the rest with Previous and Next. How many fit is worked out
// from the space the table actually has and the height each row actually
// takes (a failed rating is taller, and an opened "Show details" taller
// still), so a page is never cut off and nothing ever scrolls.
//
// No browser and no Next imports: components/admin/SessionPager.tsx measures
// and calls this, and test/sessions-paging.test.mjs calls it directly.

/**
 * Split rows into pages, in order, each page as many rows as fit `available`
 * pixels. A row taller than the whole space still gets a page of its own, so
 * every session is always reachable.
 */
export function pagesFor(heights: number[], available: number): number[][] {
  const pages: number[][] = [];
  let page: number[] = [];
  let used = 0;
  heights.forEach((h, i) => {
    if (page.length > 0 && used + h > available) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(i);
    used += h;
  });
  if (page.length > 0) pages.push(page);
  return pages;
}

/**
 * Pages as pagesFor makes them, but with a page starting exactly at row
 * `start`: what Next and Previous use, so moving a page always lands on the
 * row after the last one shown (or the first of the page before), even when
 * the rows measured differently from the last time. Without it a fresh split
 * could put a boundary one row on, and that row would never be shown.
 * Returns the pages and the index of the page that starts at `start`.
 */
export function pagesFrom(heights: number[], available: number, start: number): { pages: number[][]; at: number } {
  const s = Math.max(0, Math.min(start, heights.length));
  const before = pagesFor(heights.slice(0, s), available);
  const after = pagesFor(heights.slice(s), available).map((p) => p.map((i) => i + s));
  return { pages: [...before, ...after], at: after.length > 0 ? before.length : Math.max(0, before.length - 1) };
}

/** The page that holds row `index`, or the first page. */
export function pageHolding(pages: number[][], index: number | null): number {
  if (index === null) return 0;
  const found = pages.findIndex((p) => p.includes(index));
  return found < 0 ? 0 : found;
}

/**
 * The count under the list, in words.
 *   everything fits, no filter:    "6 sessions"
 *   everything fits, filtered:     "2 of 6 sessions"
 *   paged:                         "1 to 5 of 6 sessions"
 *   paged and filtered:            "1 to 5 of 9 sessions, from 25"
 */
export function countLine(opts: { first: number; last: number; matching: number; total: number; paged: boolean }): string {
  const { first, last, matching, total, paged } = opts;
  const noun = (n: number) => (n === 1 ? "session" : "sessions");
  if (!paged) {
    return matching === total ? `${total} ${noun(total)}` : `${matching} of ${total} ${noun(total)}`;
  }
  const range = `${first} to ${last} of ${matching} ${noun(matching)}`;
  return matching === total ? range : `${range}, from ${total}`;
}
