"use client";

// components/PendingButton.tsx: a submit button that says what it is doing.
//
// Disabled while its form is with the server, so a second press cannot send
// the same request twice from this screen; the server refuses a second submit
// for a session anyway (fni-contract-submit's lock).

import { useFormStatus } from "react-dom";

export default function PendingButton({
  children,
  pending,
  className = "btn btn--quiet",
}: {
  children: React.ReactNode;
  /** What the button says while it works: "Submitting…". */
  pending: string;
  className?: string;
}) {
  const status = useFormStatus();
  return (
    <button type="submit" className={className} disabled={status.pending} aria-busy={status.pending}>
      {status.pending ? pending : children}
    </button>
  );
}
