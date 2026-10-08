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
  saved = false,
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
  /** The status is the saved confirmation, shown as a neutral badge. */
  saved?: boolean;
}) {
  return (
    <div className="actions">
      {showBack ? (
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          <Arrow back /> {backLabel}
        </button>
      ) : (
        <span />
      )}

      <p className="actions-status" role="status" aria-live="polite">
        {saved && status ? <span className="tag">{status}</span> : status}
      </p>

      {showNext ? (
        <button
          type="button"
          className="btn btn--go"
          onClick={onNext}
          disabled={nextDisabled}
        >
          {nextLabel} <Arrow />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/** A line arrow for Back and Continue. Drawn, not a symbol character. */
function Arrow({ back = false }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {back ? <path d="M13 8H3M7 4 3 8l4 4" /> : <path d="M3 8h10M9 4l4 4-4 4" />}
    </svg>
  );
}
