"use client";

// components/Control.tsx: the one clickable control in this app.
//
// Every link to a screen goes through here, so every one shows that the
// system is working without anybody remembering to add it:
//   - the instant it is pressed, it shows a spinner and "Opening...", is
//     disabled, and a bar runs across the top of the window;
//   - it stays that way until the next page's data is drawn, not just until
//     the address changes (components/NavBusy.tsx);
//   - a second press, of it or of any other link, does nothing meanwhile.
//
// A link that opens a new tab (the customer's presentations) stays busy until
// that tab has drawn its page. A link to another site (the CRM, WorkDrive)
// opens normally: there is nothing here that could know when it has loaded.
// A press with a modifier key or the middle button opens a new tab the
// browser's way, and the page here does not wait for it.
//
// test/controls-enforced.test.mjs fails the build if a link or button
// anywhere else in the app is made without this.

import Link from "next/link";
import { useRef } from "react";
import { endNav, pathOf, startNav, useNavBusy } from "@/components/NavBusy";
import { OPENING } from "@/lib/nav-busy";

type AnchorAttrs = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick" | "target" | "rel">;

export interface ControlLinkProps extends AnchorAttrs {
  /** Where it goes. A path in this app, or a full address on another site. */
  href: string;
  children: React.ReactNode;
  /** Open in a new tab, with no handle back to this one (rel="noopener"). */
  newTab?: boolean;
  /** What it says while the page is on the way. "Opening..." unless said. */
  busyText?: string;
  /**
   * A document (a PDF, a contract in WorkDrive), not a screen: opens in a new
   * tab, and nothing here waits for it, since a file never says it is drawn.
   */
  file?: boolean;
}

function isOtherSite(href: string): boolean {
  return /^(https?:)?\/\//i.test(href) || /^(mailto|tel):/i.test(href);
}

export default function Control(props: ControlLinkProps) {
  const { href, children, newTab = false, busyText = OPENING, file = false, className, ...rest } = props;
  const self = useRef<HTMLAnchorElement>(null);
  const nav = useNavBusy();
  const external = file || isOtherSite(href);
  // A jump within this page (#field-engine.ccs): nothing to load, nothing to wait for.
  const inPage = href.startsWith("#");
  const busy = !!nav && nav.source === self.current && self.current !== null;

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (external || inPage) return;
    // The browser's own new tab: let it, and do not wait here.
    if (!newTab && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
    // One page change at a time: a second press does nothing.
    if (!startNav(self.current, href, newTab)) {
      e.preventDefault();
      return;
    }
    // A link to the page already showing changes nothing, so there is no
    // next page to wait for.
    if (!newTab && pathOf(href) === window.location.pathname + window.location.search) endNav();
  };

  const look = `${className ?? ""}${busy ? " is-busy" : ""}`.trim() || undefined;
  const inner = busy ? (
    <>
      <span className="btn-spinner" aria-hidden="true" />
      {busyText}
    </>
  ) : (
    children
  );
  const common = {
    ...rest,
    ref: self,
    className: look,
    onClick,
    "aria-disabled": busy || undefined,
    "aria-busy": busy || undefined,
  };

  if (inPage) {
    return (
      <a {...common} href={href}>
        {inner}
      </a>
    );
  }
  if (external || newTab) {
    // A new tab with no handle back to this one, and no referrer to another site.
    return (
      <a {...common} href={href} target="_blank" rel={external ? "noopener noreferrer" : "noopener"}>
        {inner}
      </a>
    );
  }
  return (
    <Link {...common} href={href} prefetch={false}>
      {inner}
    </Link>
  );
}
