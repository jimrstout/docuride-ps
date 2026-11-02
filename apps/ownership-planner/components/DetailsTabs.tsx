"use client";

// components/DetailsTabs.tsx: Details' panels, one at a time.
//
// Details fits one laptop screen: the status across the top, the next step
// along the bottom, and between them one panel at a time. The deal sheet,
// who goes on the contracts, the contracts and the menu used to stack into
// two and a half screens of scrolling.
//
// Every panel stays in the page and is only hidden, so a button in one panel
// can still send a form that sits in another (Save changes sends #vsheet), and
// a half-typed edit survives switching tabs.
//
// Which tab shows: the one the person last chose on this deal, kept for this
// browser tab only. After an action, the server can point at the panel its
// answer belongs to (a buyer saved: that panel), and does so once per answer.

import Control from "@/components/Control";
import { useEffect, useState } from "react";

export interface DetailsTab {
  id: string;
  label: string;
  /** A short count or word beside the label: "3", "Needs doing". */
  badge?: string | null;
  content: React.ReactNode;
}

export default function DetailsTabs({
  tabs,
  initial,
  pointTo,
  answerId,
  sessionId,
}: {
  tabs: DetailsTab[];
  /** The tab to show when this browser tab has no choice kept. */
  initial: string;
  /** The tab an action's answer belongs to, if it belongs to one. */
  pointTo: string | null;
  /** Changes with each action's answer, so pointTo is followed once per answer. */
  answerId: string | null;
  sessionId: string;
}) {
  const key = `docuride-details-tab:${sessionId}`;
  const known = (id: string | null | undefined) => (id && tabs.some((t) => t.id === id) ? id : null);
  const [active, setActive] = useState(() => known(pointTo) ?? known(initial) ?? tabs[0]?.id);

  // The choice kept for this deal, read after the first paint so the server's
  // HTML and the browser's agree.
  useEffect(() => {
    if (known(pointTo)) return;
    try {
      const kept = known(sessionStorage.getItem(key));
      if (kept) setActive(kept);
    } catch {
      // Storage refused (a private window): the server's choice stands.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // A new answer that names a panel shows that panel.
  useEffect(() => {
    const to = known(pointTo);
    if (to) setActive(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerId]);

  // A tab that has gone (the contracts once voided away) falls back.
  const shown = known(active) ?? known(initial) ?? tabs[0]?.id;

  const choose = (id: string) => {
    setActive(id);
    try {
      sessionStorage.setItem(key, id);
    } catch {
      // Not kept; still shown.
    }
  };

  return (
    <div className="vtabs">
      <div className="vtabs-list" role="tablist" aria-label="Deal panels">
        {tabs.map((t) => (
          <Control
            key={t.id}
            role="tab"
            id={`vtab-${t.id}`}
            aria-selected={t.id === shown}
            aria-controls={`vpanel-${t.id}`}
            tabIndex={t.id === shown ? 0 : -1}
            className={t.id === shown ? "vtabs-tab is-here" : "vtabs-tab"}
            onPress={() => choose(t.id)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              const i = tabs.findIndex((x) => x.id === t.id);
              const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
              choose(next.id);
              document.getElementById(`vtab-${next.id}`)?.focus();
            }}
          >
            {t.label}
            {t.badge ? <span className="vtabs-badge">{t.badge}</span> : null}
          </Control>
        ))}
      </div>
      {tabs.map((t) => (
        <section
          key={t.id}
          id={`vpanel-${t.id}`}
          role="tabpanel"
          aria-labelledby={`vtab-${t.id}`}
          className={`vtabs-panel vtabs-panel--${t.id}`}
          hidden={t.id !== shown}
        >
          {t.content}
        </section>
      ))}
    </div>
  );
}
