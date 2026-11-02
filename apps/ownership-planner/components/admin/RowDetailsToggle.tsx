"use client";

// components/admin/RowDetailsToggle.tsx: "Show details" for a table row.
//
// The full error opens in its own row under the session, across the whole
// width of the table, rather than inside the narrow Rating column. The row is
// rendered hidden on the server; this only shows and hides it.

import Control from "@/components/Control";
import { useState } from "react";

export default function RowDetailsToggle({ target }: { target: string }) {
  const [open, setOpen] = useState(false);

  function toggle() {
    const row = document.getElementById(target);
    if (!row) return;
    row.hidden = open;
    setOpen(!open);
  }

  return (
    <Control className="ad-linkbtn" aria-expanded={open} aria-controls={target} onPress={toggle}>
      {open ? "Hide details" : "Show details"}
    </Control>
  );
}
