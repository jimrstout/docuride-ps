"use client";

// components/NavBusy.tsx: page changes look busy until the next page is drawn.
//
// A link pressed in this app used to show nothing until the next page
// appeared, which on a slow connection is seconds, and people pressed it
// again. Now, the instant a link made with <Control href> is pressed:
//   - a bar runs across the top of the window;
//   - the pressed control shows a spinner and "Opening...", and is disabled;
//   - every other link made with <Control> does nothing until it ends.
// It ends when the next page's data is drawn. Pages here load their data on
// the server, so the router changes page only once the next page's data has
// arrived, and it changes the content and the address in one commit. The
// watcher sees that commit (the path or the query it reads changes) and ends
// the busy state on the frame after, once the new page has been painted.
//
// A link that opens a new tab (Present menu, Present storyboard) ends when
// that tab says it has drawn its page, over a BroadcastChannel: the new tab's
// <DrawnSignal /> announces its address once its page is on screen.
//
// Either way, after a long wait it ends anyway, so a lost signal never leaves
// the screen stuck.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { DRAWN_CHANNEL as CHANNEL, NAV_GIVE_UP_MS } from "@/lib/nav-busy";

export interface NavJob {
  /** The control that was pressed. */
  source: HTMLElement | null;
  /** Where it goes, as a path with its query. */
  to: string;
  newTab: boolean;
  /** The page showing when it was pressed: path and query. */
  from: string;
}

let job: NavJob | null = null;
const listeners = new Set<() => void>();
let giveUp: ReturnType<typeof setTimeout> | null = null;

function emit() {
  for (const l of listeners) l();
}

/** The address a link goes to, as this app compares them: path and query. */
export function pathOf(href: string): string {
  try {
    const u = new URL(href, window.location.href);
    return u.origin === window.location.origin ? u.pathname + u.search : href;
  } catch {
    return href;
  }
}

/** A page change in flight, or null. */
export function navBusy(): NavJob | null {
  return job;
}

export function subscribeNav(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Start one. False when one is already running: the press does nothing. */
export function startNav(source: HTMLElement | null, href: string, newTab: boolean): boolean {
  if (job) return false;
  job = { source, to: pathOf(href), newTab, from: window.location.pathname + window.location.search };
  if (giveUp) clearTimeout(giveUp);
  giveUp = setTimeout(endNav, NAV_GIVE_UP_MS);
  emit();
  return true;
}

export function endNav() {
  if (!job) return;
  job = null;
  if (giveUp) clearTimeout(giveUp);
  giveUp = null;
  emit();
}

export function useNavBusy(): NavJob | null {
  return useSyncExternalStore(subscribeNav, navBusy, () => null);
}

/**
 * Once in the root layout: the bar across the top while a page change runs,
 * and the watcher that ends it when the next page is drawn.
 */
export function NavWatcher() {
  const running = useNavBusy();
  const path = usePathname();
  const query = useSearchParams()?.toString() ?? "";
  const here = query ? `${path}?${query}` : path;
  const last = useRef(here);

  // The router committed another page: its data is drawn. End on the next
  // frame, after the browser has painted it.
  useEffect(() => {
    if (here === last.current) return;
    last.current = here;
    const j = navBusy();
    if (!j || j.newTab) return;
    // A loading screen (app/details/[sessionId]/loading.tsx) means the page's
    // data is still on the way: wait for it to give way to the page.
    const drawn = () => !document.querySelector("[data-page-loading]");
    const finish = () => requestAnimationFrame(() => navBusy() === j && endNav());
    if (drawn()) {
      finish();
      return;
    }
    const obs = new MutationObserver(() => {
      if (!drawn()) return;
      obs.disconnect();
      finish();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [here]);

  useEffect(() => {
    if (!running) return;
    // New tab: that tab says when its page is drawn.
    let channel: BroadcastChannel | null = null;
    if (running.newTab && typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (e: MessageEvent<{ path?: string }>) => {
        if (e.data?.path === running.to) endNav();
      };
    }
    // Coming back to this page from the browser's history: nothing to wait for.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) endNav();
    };
    window.addEventListener("pageshow", onShow);
    return () => {
      channel?.close();
      window.removeEventListener("pageshow", onShow);
    };
  }, [running]);

  return running ? <div className="nav-busy" role="progressbar" aria-label="Opening" /> : null;
}

/**
 * Once in the root layout: when this tab's first page is on the screen, tell
 * the tab that opened it (Present menu, Present storyboard).
 */
export function DrawnSignal() {
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ path: window.location.pathname + window.location.search });
    channel.close();
  }, []);
  return null;
}
