"use client";

// components/SubmitConfirm.tsx: Submit contracts, with a confirmation first.
//
// Pressing "Submit contracts" opens a modal and sends nothing. The modal shows
// what is about to go out (components/SubmitSummary.tsx), and only Confirm
// Submit sends the form. Cancel, or Escape, closes it and sends nothing.
//
// When the buyer, co-buyer or lienholder was changed on Details, the DX1
// confirmation is in the modal and Confirm Submit stays disabled until it is
// ticked. The Edge Function refuses without it and records it as the session
// event "Contract detail changes confirmed for DX1" (contract-parties.ts).
//
// Confirm Submit is the page's usual busy button (components/PendingButton.tsx,
// components/Working.tsx): one spinner, one label, and a second tap cannot
// send again. While it runs the modal cannot be closed. When the submit has
// answered, the modal closes and the result is shown on the page.
//
// A voided contract spends the rate it was made from (supabase/functions/
// _shared/spent-rates.ts). Then Submit contracts first refreshes the rating
// (refreshSpentRates), and the page comes back with the modal open: with the
// note that prices are unchanged, or, when any changed, each difference and
// Confirm Submit disabled. A refresh never submits.
//
// On a phone the modal fits the screen: the product list scrolls inside it and
// the buttons stay in view (app/globals.css, .vconfirm).

import { useEffect, useRef, useState } from "react";
import PendingButton from "@/components/PendingButton";
import SubmitSummary from "@/components/SubmitSummary";
import { Working, useWorking } from "@/components/Working";
import { DX1_CONFIRMATION } from "@/lib/contract-parties";
import { SUBMIT_LEAVE } from "@/lib/working";
import type { PartyChange, SubmitConfirmation } from "@/lib/types";
import { refreshSpentRates, submitContracts } from "@/app/console-actions";

export default function SubmitConfirm({
  sessionId,
  confirmation,
  changes,
  blocked,
  note = null,
  autoOpen = false,
  children,
}: {
  sessionId: string;
  confirmation: SubmitConfirmation;
  /** Contract details changed on Details. Any at all puts the DX1 confirmation in the modal. */
  changes: PartyChange[];
  /** Why Submit cannot be pressed now (lib/submit-check.ts), or null. */
  blocked: string | null;
  /**
   * Said beside the button and above the products in the modal, without
   * blocking: an out-of-date rating on a test session (lib/submit-check.ts).
   */
  note?: string | null;
  /** Open the modal as the page loads: a refresh has just answered. */
  autoOpen?: boolean;
  /** Anything else the form sends, shown on the page beside the button. */
  children?: React.ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState(false);
  const area = useWorking();
  const busy = !!area?.running && area.running.form === form.current && form.current !== null;
  const needsDx1 = changes.length > 0;
  const held = confirmation.held ?? null;
  // A spent rate is refreshed before the modal opens, unless a refresh has
  // already held the submit.
  const refreshFirst = (confirmation.spent?.length ?? 0) > 0 && !held;

  // The submit has answered: close the modal, so the result shows on the page.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) wasBusy.current = true;
    else if (wasBusy.current) {
      wasBusy.current = false;
      dialog.current?.close();
    }
  }, [busy]);

  const show = () => {
    setTicked(false);
    dialog.current?.showModal();
    setOpen(true);
  };
  useEffect(() => {
    if (autoOpen && !blocked && !refreshFirst) show();
    // Once, as the page loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cancel = () => {
    if (!busy) dialog.current?.close();
  };

  return (
    <form action={submitContracts} ref={form} className="vsubmit">
      <Working />
      <input type="hidden" name="session_id" value={sessionId} />
      {children}
      {blocked ? (
        <p className="console-flash console-flash--bad" role="alert">{blocked}</p>
      ) : note ? (
        <p className="vsubmit-note" role="status">{note}</p>
      ) : null}
      {refreshFirst ? (
        <PendingButton
          className="btn"
          working="page"
          pending="Refreshing the rating..."
          formAction={refreshSpentRates}
          formNoValidate
          disabled={!!blocked}
        >
          Submit contracts
        </PendingButton>
      ) : (
        <button type="button" className="btn" onClick={show} disabled={!!blocked} aria-haspopup="dialog">
          Submit contracts
        </button>
      )}

      <dialog
        ref={dialog}
        className="vconfirm"
        aria-labelledby="vconfirm-title"
        onClose={() => setOpen(false)}
        onCancel={(e) => {
          // Escape while it is sending would hide a submit that is still running.
          if (busy) e.preventDefault();
        }}
      >
        <div className="vconfirm-body">
          <SubmitSummary confirmation={confirmation} changes={changes} note={note} titleId="vconfirm-title" />
          {held ? (
            <div className="console-flash console-flash--bad vconfirm-held" role="alert">
              <p>{held.message}</p>
              <ul className="vdx1-list">
                {held.differences.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          ) : confirmation.refresh_note ? (
            <p className="vsubmit-note" role="status">{confirmation.refresh_note}</p>
          ) : null}
          {needsDx1 ? (
            <label className="vdx1-confirm vconfirm-dx1">
              <input
                type="checkbox"
                name="dx1_confirmed"
                value="1"
                required
                checked={ticked}
                onChange={(e) => setTicked(e.target.checked)}
              />{" "}
              {DX1_CONFIRMATION}
            </label>
          ) : null}
        </div>
        <div className="vconfirm-actions">
          <button type="button" className="btn btn--quiet" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <PendingButton
            className="btn btn--go"
            working="page"
            pending="Submitting contracts..."
            leave={SUBMIT_LEAVE}
            disabled={!open || !!blocked || !!held || (needsDx1 && !ticked)}
          >
            Confirm Submit
          </PendingButton>
        </div>
      </dialog>
    </form>
  );
}
