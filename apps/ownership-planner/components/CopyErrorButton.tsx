"use client";

// components/CopyErrorButton.tsx: "Copy error", for sending to the provider.
//
// Copies the deal number, the provider and time, and the provider's text
// exactly as stored (lib/rating-error.ts, copyErrorText). Where the clipboard
// cannot be written (an older browser, a page not served over https), the
// text is selected instead so it can be copied by hand.

import { useEffect, useRef, useState } from "react";

export default function CopyErrorButton({ text, className }: { text: string; className?: string }) {
  const [said, setSaid] = useState<string>("");
  const fallback = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(""), 2500);
    return () => clearTimeout(t);
  }, [said]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setSaid("Copied.");
    } catch {
      const area = fallback.current;
      if (area) {
        area.hidden = false;
        area.select();
        const ok = document.execCommand?.("copy") ?? false;
        setSaid(ok ? "Copied." : "Selected. Press Ctrl+C or Cmd+C to copy.");
        if (ok) area.hidden = true;
      }
    }
  }

  return (
    <span className="copy-error">
      <button type="button" className={className ?? "copy-error-btn"} onClick={copy}>
        Copy error
      </button>
      <span className="copy-error-said" role="status" aria-live="polite">
        {said}
      </span>
      <textarea ref={fallback} className="copy-error-fallback" readOnly hidden value={text} aria-label="Error text to copy" />
    </span>
  );
}
