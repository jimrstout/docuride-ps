"use client";

// components/admin/AdminNav.tsx: the sidebar's sections, and the page name in
// the breadcrumb, both from the address showing now.
//
// The admin layout stays put while staff move between its pages, so anything
// it worked out from the first request (which page was open) goes stale: open
// Stores, choose Sessions, and the layout still said Stores. These read the
// current path on the client instead, so the highlight and the breadcrumb
// always name the page on screen.

import Control from "@/components/Control";
import { usePathname } from "next/navigation";
import { sectionFor, type AdminSection } from "@/lib/admin-sections";
import { Icon } from "@/components/admin/Icon";

/** The section the page on screen belongs to, or null. */
export function useHere(): AdminSection | null {
  return sectionFor(usePathname() ?? "");
}

export default function AdminNav({ sections }: { sections: readonly AdminSection[] }) {
  const here = useHere();
  return (
    <nav className="ad-nav" aria-label="Admin sections">
      {sections.map((s) => (
        <Control
          key={s.href}
          href={s.href}
          className={s.href === here?.href ? "ad-nav-link is-here" : "ad-nav-link"}
          aria-current={s.href === here?.href ? "page" : undefined}
        >
          <Icon name={s.icon} />
          <span className="ad-nav-label">{s.label}</span>
        </Control>
      ))}
    </nav>
  );
}

/** The page's name, last in the breadcrumb. */
export function AdminCrumbHere() {
  return <strong>{useHere()?.label ?? "Sessions"}</strong>;
}
