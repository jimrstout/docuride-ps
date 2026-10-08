// The numbered progress indicator in the application header.
//
// It reports position and it navigates backwards, because the flow already
// allows that and a customer who wants to change an earlier decision should
// not have to press Back four times to get there. It does NOT navigate
// forwards: a step ahead of where the customer has reached is not a tab, and
// styling it as one invites a click that cannot be honoured.

"use client";

export interface Step {
  /** 1-based number the customer sees. */
  n: number;
  label: string;
}

export default function ProgressStepper({
  steps,
  current,
  furthest,
  onGo,
}: {
  steps: Step[];
  /** 0-based index of the step being shown. */
  current: number;
  /** 0-based index of the furthest step reached, which bounds what is clickable. */
  furthest: number;
  onGo: (index: number) => void;
}) {
  return (
    <nav className="stepper" aria-label="Progress">
      <ol>
        {steps.map((s, i) => {
          const state =
            i < current ? "done" : i === current ? "current" : "ahead";
          const reachable = i < current || (i <= furthest && i !== current);
          const label = `Step ${s.n} of ${steps.length}, ${s.label}`;

          return (
            <li key={s.label} className={`step step--${state}`}>
              {reachable ? (
                <button
                  type="button"
                  onClick={() => onGo(i)}
                  aria-label={`Go back to ${label}`}
                >
                  <StepNumber n={s.n} done={state === "done"} />
                  <span className="step-label">{s.label}</span>
                </button>
              ) : (
                <span
                  {...(state === "current" ? { "aria-current": "step" } : {})}
                  aria-label={label}
                >
                  <StepNumber n={s.n} done={state === "done"} />
                  <span className="step-label" aria-hidden="true">{s.label}</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {/* On a tablet or a phone the five steps do not fit, so the bar says
          which one this is instead. The stylesheet shows one or the other. */}
      <p className="stepper-compact">
        Step {steps[current].n} of {steps.length}: <span>{steps[current].label}</span>
      </p>
    </nav>
  );
}

/** The step's number, or a drawn tick once the step is done. */
function StepNumber({ n, done }: { n: number; done: boolean }) {
  return (
    <span className="step-n" aria-hidden="true">
      {done ? <span className="tick" /> : n}
    </span>
  );
}
