"use client";

// components/admin/StoreName.tsx: a store's full name in the Sessions list,
// never cut off.
//
// The CRM's full name wraps onto two lines ("All Seasons Powersports," then
// "Barboursville/Huntington"). If even two lines are not enough for the
// column, the place (after the comma) comes first in normal text and the
// group (before it) underneath, smaller and grey, so every row still says
// which location it is. Measured in the browser, and again whenever the
// column's width changes; the server sends the full name.

import { useLayoutEffect, useRef, useState } from "react";

/** "Group, Place" as its two parts, or null when there is no comma to split at. */
export function storeParts(name: string): { group: string; place: string } | null {
  const at = name.indexOf(",");
  if (at <= 0) return null;
  const group = name.slice(0, at).trim();
  const place = name.slice(at + 1).trim();
  return group && place ? { group, place } : null;
}

export default function StoreName({ name }: { name: string | null }) {
  const full = useRef<HTMLSpanElement>(null);
  const [split, setSplit] = useState(false);
  const [width, setWidth] = useState(0);
  const parts = name ? storeParts(name) : null;

  // Whenever the column's width changes, start again from the full name.
  useLayoutEffect(() => {
    const cell = full.current?.parentElement;
    if (!cell || !parts) return;
    let last = cell.clientWidth;
    const watch = new ResizeObserver(() => {
      if (cell.clientWidth !== last) {
        last = cell.clientWidth;
        setSplit(false);
        setWidth(last);
      }
    });
    watch.observe(cell);
    return () => watch.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // The full name showing: more than two lines, and it splits.
  useLayoutEffect(() => {
    const el = full.current;
    if (!el || split || !parts) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 16;
    if (el.getBoundingClientRect().height > line * 2 + 1) setSplit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [split, width, name]);

  if (!name) return <span className="ad-store-full">Not set</span>;
  if (split && parts) {
    return (
      <span className="ad-store-split" title={name}>
        <span className="ad-store-place">{parts.place}</span>
        <small className="ad-store-group">{parts.group}</small>
      </span>
    );
  }
  return (
    <span ref={full} className="ad-store-full" title={name}>
      {/* The location kept together where it fits, so the line breaks after the comma. */}
      {parts ? (
        <>
          {parts.group},{" "}
          <span className="ad-store-whole">{parts.place}</span>
        </>
      ) : (
        name
      )}
    </span>
  );
}
