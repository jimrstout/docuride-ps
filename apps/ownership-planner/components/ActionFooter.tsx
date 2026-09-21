// The one control bar, in the same place on every screen.
//
// Back is never the same weight as the forward action, and the save state sits
// between them rather than floating somewhere the customer has to hunt for it:
// a plan that silently failed to save is the failure worth being loud about.

"use client";

export type SaveState = "idle" | "saving" | "saved" | "error";

export default function ActionFooter({
  onBack,
  backLabel = "Back",
  showBack,
  onNext,
  nextLabel,
  nextDisabled,
  showNext = true,
  status,
}: {
  onBack: () => void;
  backLabel?: string;
  showBack: boolean;
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  /** False at the end of the flow, where there is nowhere further to go. A
      button that does nothing is worse here than no button at all. */
  showNext?: boolean;
  status?: React.ReactNode;
}) {
  return (
    <div className="actions">
      {showBack ? (
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          <span aria-hidden="true">←</span> {backLabel}
        </button>
      ) : (
        <span />
      )}

      <p className="actions-status" role="status" aria-live="polite">{status}</p>

      {showNext ? (
        <button
          type="button"
          className="btn btn--go"
          onClick={onNext}
          disabled={nextDisabled}
        >
          {nextLabel} <span aria-hidden="true">→</span>
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}
