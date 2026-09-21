// A discovery question and its answers.
//
// One question to a screen and one row to an answer. The cards carried a
// photograph until the screen had to fit a viewport; the label and the hint
// always did the actual work, so what went is decoration. Each is still a real
// pressed-state button, readable on its own, at a full tap target.

"use client";

import type { DiscoveryQuestion } from "@/lib/profiles";

export default function OwnershipQuestion({
  question,
  chosen,
  onToggle,
}: {
  question: DiscoveryQuestion;
  chosen: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <fieldset className="question">
      <legend className="question-legend">
        <span className="question-title">{question.question}</span>
        <span className="question-help">{question.help}</span>
      </legend>

      <div className="choices">
        {question.options.map((o) => {
          const on = chosen.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              className={`choice ${on ? "is-chosen" : ""}`}
              aria-pressed={on}
              onClick={() => onToggle(o.value)}
            >
              <span className="choice-box" aria-hidden="true" />
              <span className="choice-text">
                <b>{o.label}</b>
                <small>{o.hint}</small>
              </span>
            </button>
          );
        })}
      </div>

    </fieldset>
  );
}
