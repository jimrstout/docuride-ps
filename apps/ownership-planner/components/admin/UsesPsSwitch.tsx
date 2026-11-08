"use client";

// components/admin/UsesPsSwitch.tsx: "Uses DocuRide PS" for one store, saved as soon as it moves.
//
// A checkbox drawn as a switch. Moving it sends its form at once
// (saveStoreUsesPs), and the page shows the store's new place: on, it joins
// the stores PS lists by default; off, it shows only under Show all stores.

import { useRef } from "react";
import { Working } from "@/components/Working";
import { saveStoreUsesPs } from "@/app/console-actions";

export default function UsesPsSwitch({
  storeId,
  storeName,
  on,
  showingAll,
}: {
  storeId: string;
  storeName: string;
  on: boolean;
  showingAll: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={saveStoreUsesPs} className="ad-switch-form" data-working-panel="">
      <Working />
      <input type="hidden" name="store_id" value={storeId} />
      {showingAll ? <input type="hidden" name="all" value="1" /> : null}
      <label className="ad-switch" title={`Uses DocuRide PS: ${storeName}`}>
        <input
          type="checkbox"
          name="uses_ps"
          role="switch"
          defaultChecked={on}
          aria-label={`Uses DocuRide PS: ${storeName}`}
          onChange={() => form.current?.requestSubmit()}
        />
        <span className="ad-switch-track" aria-hidden="true" />
        <span className="ad-switch-text">Uses DocuRide PS</span>
      </label>
    </form>
  );
}
