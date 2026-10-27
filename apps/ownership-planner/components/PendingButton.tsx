"use client";

// components/PendingButton.tsx: a submit button that says what it is doing.
//
// While its form is with the server it shows a spinner and its working label
// ("Submitting contracts..."), and is disabled, so a second press cannot send
// the same request twice from this screen. The server refuses a second submit
// for a session anyway (fni-contract-submit's lock), and a second void of the
// same contract (fni-contract-void's).
//
// `working` says how big the action is, for the page's working state
// (components/Working.tsx): "page" covers the page with an overlay, "panel"
// locks the panel the form sits in. `leave` is the warning shown if the page
// is left while it runs, for Submit and Void only.

import { useRef } from "react";
import { useFormStatus } from "react-dom";
import { useWorking } from "@/components/Working";
import type { WorkingScope } from "@/lib/working";

export default function PendingButton({
  children,
  pending,
  className = "btn btn--quiet",
  working = "panel",
  leave,
  form,
  disabled,
  title,
  formAction,
  formNoValidate,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  /** What the button says while it works: "Submitting contracts...". */
  pending: string;
  className?: string;
  working?: WorkingScope;
  leave?: string;
  /** The id of the form it sends, when it sits outside that form. */
  form?: string;
  disabled?: boolean;
  title?: string;
  /** A second action in the same form, as on a plain button. */
  formAction?: (formData: FormData) => void | Promise<void>;
  formNoValidate?: boolean;
  "aria-label"?: string;
}) {
  const status = useFormStatus();
  const area = useWorking();
  const self = useRef<HTMLButtonElement>(null);
  // Inside a working area, busy only when this is the button that sent the
  // form: a form can have more than one. Outside one, the form's own state.
  const busy = area ? area.running?.submitter === self.current && self.current !== null : status.pending;
  return (
    <button
      ref={self}
      type="submit"
      form={form}
      title={title}
      formAction={formAction}
      formNoValidate={formNoValidate}
      aria-label={ariaLabel}
      className={`${className}${busy ? " is-busy" : ""}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-working={working}
      data-working-label={pending}
      data-working-leave={leave}
    >
      {busy ? (
        <>
          <span className="btn-spinner" aria-hidden="true" />
          {pending}
        </>
      ) : (
        children
      )}
    </button>
  );
}
