"use client";

// components/admin/SessionFilters.tsx: search and filters for the session list.
//
// Client-side, over the rows the page already loaded. Each row carries what it
// is filtered on as data attributes, and this hides the rows that do not
// match. Nothing is fetched and nothing is sent anywhere. Without JavaScript
// the controls do nothing and every row stays visible, which is the list as
// it was.

import { useEffect, useState } from "react";

export interface FilterOption {
  value: string;
  label: string;
}

export function SessionFilters({
  tableId,
  countId,
  stores,
  statuses,
  ratings,
}: {
  tableId: string;
  countId: string;
  stores: FilterOption[];
  statuses: FilterOption[];
  ratings: FilterOption[];
}) {
  const [q, setQ] = useState("");
  const [store, setStore] = useState("");
  const [status, setStatus] = useState("");
  const [rating, setRating] = useState("");

  useEffect(() => {
    const rows = document.querySelectorAll<HTMLTableRowElement>(`#${tableId} tbody tr[data-row]`);
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    rows.forEach((tr) => {
      const d = tr.dataset;
      const ok =
        (store === "" || d.store === store) &&
        (status === "" || d.status === status) &&
        (rating === "" || d.rating === rating) &&
        words.every((w) => (d.search ?? "").includes(w));
      tr.hidden = !ok;
      if (ok) shown += 1;
    });
    // One line in place of the rows when the filters leave none.
    document
      .querySelectorAll<HTMLTableRowElement>(`#${tableId} tbody tr[data-none]`)
      .forEach((tr) => (tr.hidden = shown !== 0 || rows.length === 0));
    const count = document.getElementById(countId);
    if (count) {
      const total = rows.length;
      count.textContent =
        shown === total
          ? `${total} ${total === 1 ? "session" : "sessions"}`
          : `${shown} of ${total} sessions`;
    }
  }, [q, store, status, rating, tableId, countId]);

  return (
    <div className="ad-toolbar" role="search">
      <label className="ad-search">
        <span className="sr-only">Search sessions</span>
        <input
          type="text"
          className="ad-input"
          style={{ width: "100%" }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search deal number, stock number, vehicle or store"
          autoComplete="off"
        />
      </label>
      <Select label="Store" all="All stores" value={store} onChange={setStore} options={stores} />
      <Select label="Status" all="Any status" value={status} onChange={setStatus} options={statuses} />
      <Select label="Rating" all="Any rating" value={rating} onChange={setRating} options={ratings} />
    </div>
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
