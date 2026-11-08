"use client";

// components/admin/SessionFilters.tsx: search and filters for the session list.
//
// Client-side, over the rows the page already loaded. Each row carries what it
// is filtered on as data attributes, and this marks each row as matching or
// not (data-match) and says so (FILTERED_EVENT). SessionPager then shows the
// matching rows a page at a time, starting again at page 1. Nothing is
// fetched and nothing is sent anywhere. Without JavaScript the controls do
// nothing and every row stays visible, which is the list as it was.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FILTERED_EVENT } from "./SessionPager";

/** Where the store choice is drawn: the top bar, left of the person's email (app/admin/layout.tsx). */
export const TOP_TOOLS_ID = "ad-top-tools";
/** The last store chosen, for this browser session. */
export const STORE_CHOICE_KEY = "ps.sessions.store";

export interface FilterOption {
  value: string;
  label: string;
}

export function SessionFilters({
  tableId,
  stores,
  statuses,
  ratings,
}: {
  tableId: string;
  /** The stores the person may see: value is the store's id, label its full name. */
  stores: FilterOption[];
  statuses: FilterOption[];
  ratings: FilterOption[];
}) {
  const [q, setQ] = useState("");
  // "" is "All my stores". Remembered in this browser for the session.
  const [store, setStore] = useState("");
  const [topBar, setTopBar] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTopBar(document.getElementById(TOP_TOOLS_ID));
    try {
      const kept = window.sessionStorage.getItem(STORE_CHOICE_KEY) ?? "";
      if (kept && stores.some((s) => s.value === kept)) setStore(kept);
    } catch {
      // No storage: the default stands.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chooseStore = (v: string) => {
    setStore(v);
    try {
      window.sessionStorage.setItem(STORE_CHOICE_KEY, v);
    } catch {
      // No storage: chosen for this page only.
    }
  };
  const [status, setStatus] = useState("");
  const [rating, setRating] = useState("");

  // Filters first, then paging: mark the rows, and the pager shows the
  // matching ones from page 1.
  const [first, setFirst] = useState(true);
  useEffect(() => {
    const table = document.getElementById(tableId);
    // The order the footer names: by store with every store, most recent first in one.
    if (table) table.dataset.order = store === "" && stores.length > 1 ? "store" : "recent";
    const rows = document.querySelectorAll<HTMLTableRowElement>(`#${tableId} tbody tr[data-row]`);
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    rows.forEach((tr) => {
      const d = tr.dataset;
      const ok =
        (store === "" || d.store === store) &&
        (status === "" || d.status === status) &&
        (rating === "" || d.rating === rating) &&
        words.every((w) => (d.search ?? "").includes(w));
      tr.dataset.match = ok ? "1" : "0";
    });
    // The pager lays out the first page on its own; after that, every change
    // of filter sends it back to page 1.
    if (first) setFirst(false);
    else window.dispatchEvent(new Event(FILTERED_EVENT));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, store, status, rating, tableId]);

  // Only for someone who sees more than one store.
  const storeChoice =
    stores.length > 1 ? (
      <label className="ad-store-choice">
        <span className="sr-only">Store</span>
        <select value={store} onChange={(e) => chooseStore(e.target.value)}>
          <option value="">All my stores</option>
          {stores.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  return (
    <>
    {storeChoice && topBar ? createPortal(storeChoice, topBar) : storeChoice}
    <div className="ad-toolbar" role="search">
      <label className="ad-search">
        <span className="sr-only">Search sessions</span>
        <input
          type="text"
          className="ad-input"
          style={{ width: "100%" }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search deal number, customer, stock number, vehicle or store"
          autoComplete="off"
        />
      </label>
      <Select label="Status" all="Any status" value={status} onChange={setStatus} options={statuses} />
      <Select label="Rating" all="Any rating" value={rating} onChange={setRating} options={ratings} />
    </div>
    </>
  );
}

function Select({
  label,
  all,
  value,
  onChange,
  options,
}: {
  label: string;
  all: string;
  value: string;
  onChange: (v: string) => void;
  options: FilterOption[];
}) {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
