"use client";

// components/admin/AdminMenu.tsx: every admin section, by name, behind one
// button on a small screen.
//
// Below tablet width the sidebar becomes a top bar, and a row of six icons
// did not fit beside the brand on a phone. So the icons give way to a Menu
// button that opens a panel listing each section by name. Closed again by a
// choice, by Escape, or by pressing the button. Hidden on wider screens,
// where the sidebar lists the sections itself.

import Control from "@/components/Control";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { AdminSection } from "@/lib/admin-sections";
import { Icon } from "@/components/admin/Icon";

export default function AdminMenu({ sections, here }: { sections: readonly AdminSection[]; here: string | null }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();

  // A choice has been made and its page is up: the panel goes. It stays open
  // meanwhile, with the chosen section showing "Opening...".
  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="ad-menu">
      <button
        type="button"
        className="ad-menu-button"
        aria-expanded={open}
        aria-controls="ad-menu-panel"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ad-menu-bars" aria-hidden="true" />
        Menu
      </button>
      {open ? (
        <nav id="ad-menu-panel" className="ad-menu-panel" aria-label="Admin sections">
          {sections.map((s) => (
            <Control
              key={s.href}
              href={s.href}
              className={s.href === here ? "ad-menu-link is-here" : "ad-menu-link"}
              aria-current={s.href === here ? "page" : undefined}
            >
              <Icon name={s.icon} />
              <span>{s.label}</span>
            </Control>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
