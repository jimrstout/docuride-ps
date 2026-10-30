"use client";

// components/SaleDateWatch.tsx: Details picks up a sale date changed in the CRM.
//
// Shown only while the date line is. When the tab regains focus, and every 30
// seconds, it asks the page to load again; the load reads the Sale_Date fresh
// from the CRM (fni-session-verify), so a date staff just changed in the CRM
// shows here without pressing anything. It waits while the page is working on
// something (components/Working.tsx). Refresh from CRM stays as the fallback.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { DATE_WATCH_MS } from "@/lib/crm-link";

export default function SaleDateWatch() {
  const router = useRouter();
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== "visible") return;
      if (document.querySelector('[aria-busy="true"]')) return;
      router.refresh();
    };
    const timer = window.setInterval(check, DATE_WATCH_MS);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [router]);
  return null;
}
