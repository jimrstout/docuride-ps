"use client";

// components/admin/SessionPager.tsx: the Sessions list, one screen at a time.
//
// On a laptop the list shows as many sessions as fit without scrolling, and
// Previous and Next page through the rest, with a count: "1 to 5 of 6
// sessions". When everything fits, the buttons are not shown.
//
// How many fit is measured, not guessed: the space the table has, and each
// matching row's own height, split into pages by lib/session-pages.ts.
// Measured again when the window changes size or a "Show details" opens, and
// the page then keeps the session that was at its top in view.
//
// The filters (SessionFilters) mark each row as matching or not and say so;
// paging runs on the matching rows only, so a filter always applies before
// paging, and changing one goes back to page 1.
//
// A phone, or a window shorter than a laptop's, keeps the ordinary scrolling
// list with every matching row, and no buttons. Without JavaScript every row
// shows, as before.

import Control from "@/components/Control";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { countLine, pageHolding, pagesFor } from "@/lib/session-pages";

/** The same test the stylesheet uses for the one-screen list (admin.css). */
const FITS = "(min-width: 900px) and (min-height: 600px)";

/** Said by SessionFilters each time the filters change. */
export const FILTERED_EVENT = "ad-sessions:filtered";

type View = { page: number; pages: number; first: number; last: number; matching: number; total: number };

export function SessionPager({ tableId, total }: { tableId: string; total: number }) {
  const [view, setView] = useState<View>({ page: 0, pages: 1, first: 1, last: total, matching: total, total });
  const page = useRef(0);
  const pages = useRef<number[][]>([]);
  /** The row at the top of the page being shown, kept across a re-measure. */
  const anchor = useRef<HTMLTableRowElement | null>(null);

  const layout = useCallback(
    (to: "first" | "anchor" | number) => {
      const table = document.getElementById(tableId);
      const scroller = table?.closest<HTMLElement>(".ad-scroll");
      if (!table || !scroller) return;
      const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row]"));
      const matching = rows.filter((r) => r.dataset.match !== "0");
      const none = table.querySelector<HTMLTableRowElement>("tbody tr[data-none]");

      // Every matching row on, so each can be measured; the rest off.
      rows.forEach((r) => (r.hidden = r.dataset.match === "0"));
      if (none) none.hidden = matching.length > 0 || rows.length === 0;

      const fits = window.matchMedia(FITS).matches;
      let split: number[][];
      if (!fits || matching.length === 0) {
        split = [matching.map((_, i) => i)];
      } else {
        const head = table.querySelector("thead")?.getBoundingClientRect().height ?? 0;
        const available = scroller.clientHeight - head;
        const heights = matching.map((r) => {
          const why = r.nextElementSibling as HTMLElement | null;
          const extra = why?.classList.contains("ad-why-row") && !why.hidden ? why.getBoundingClientRect().height : 0;
          return r.getBoundingClientRect().height + extra;
        });
        split = pagesFor(heights, available);
      }

      const at =
        to === "first" ? 0
        : to === "anchor" ? pageHolding(split, anchor.current ? matching.indexOf(anchor.current) : null)
        : Math.max(0, Math.min(to, split.length - 1));
      const shown = new Set((split[at] ?? []).map((i) => matching[i]));
      matching.forEach((r) => (r.hidden = !shown.has(r)));

      pages.current = split;
      page.current = at;
      anchor.current = matching[split[at]?.[0] ?? -1] ?? null;
      const onPage = split[at] ?? [];
      setView({
        page: at,
        pages: split.length,
        first: onPage.length ? onPage[0] + 1 : 0,
        last: onPage.length ? onPage[onPage.length - 1] + 1 : 0,
        matching: matching.length,
        total: rows.length,
      });
    },
    [tableId]
  );

  // The first page, before the browser paints the full list.
  useLayoutEffect(() => layout("first"), [layout]);

  useEffect(() => {
    const onFiltered = () => layout("first");
    const onResize = () => layout("anchor");
    window.addEventListener(FILTERED_EVENT, onFiltered);
    window.addEventListener("resize", onResize);
    // The table's own space changes without the window changing too: the
    // notes under the list opened, a notice shown. Showing and hiding rows
    // never changes it (the space is fixed by the page, not by the rows).
    const scroller = document.getElementById(tableId)?.closest(".ad-scroll");
    let lastHeight = -1;
    const sized = new ResizeObserver((entries) => {
      const h = Math.round(entries[0]?.contentRect.height ?? 0);
      if (h !== lastHeight) {
        if (lastHeight !== -1) layout("anchor");
        lastHeight = h;
      }
    });
    if (scroller) sized.observe(scroller);
    // A "Show details" opening or closing changes how much fits.
    const tbody = document.querySelector(`#${tableId} tbody`);
    const watch = new MutationObserver((changes) => {
      if (changes.some((c) => (c.target as HTMLElement).classList?.contains("ad-why-row"))) layout("anchor");
    });
    if (tbody) watch.observe(tbody, { attributes: true, attributeFilter: ["hidden"], subtree: true });
    return () => {
      window.removeEventListener(FILTERED_EVENT, onFiltered);
      window.removeEventListener("resize", onResize);
      sized.disconnect();
      watch.disconnect();
    };
  }, [layout, tableId]);

  const paged = view.pages > 1;
  return (
    <>
      <span id={`${tableId}-count`} aria-live="polite">
        {countLine({ first: view.first, last: view.last, matching: view.matching, total: view.total, paged })}
      </span>
      {paged ? (
        <span className="ad-pager" role="group" aria-label="Pages">
          <Control
            className="ad-btn ad-btn--secondary"
            onPress={() => layout(page.current - 1)}
            disabled={view.page === 0}
          >
            Previous
          </Control>
          <Control
            className="ad-btn ad-btn--secondary"
            onPress={() => layout(page.current + 1)}
            disabled={view.page >= view.pages - 1}
          >
            Next
          </Control>
        </span>
      ) : (
        <span>Most recent first</span>
      )}
    </>
  );
}
