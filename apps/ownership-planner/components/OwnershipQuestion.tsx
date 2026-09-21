// A discovery question and its visual answers.
//
// The photographs are the point: "weekends and back roads" is a place before
// it is a category, and a picture says it faster than a label. They are also
// decorative in the strict sense -- the label and hint carry the meaning -- so
// each card is a real pressed-state button with its text readable on its own,
// and the image carries a description for anyone who cannot see it.

"use client";

import { PHOTOGRAPHY_READY, type DiscoveryQuestion } from "@/lib/profiles";

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
              className={`choice ${on ? "is-chosen" : ""} ${PHOTOGRAPHY_READY ? "" : "choice--plain"}`}
              aria-pressed={on}
              onClick={() => onToggle(o.value)}
            >
              {PHOTOGRAPHY_READY && (
                <img className="choice-pic" src={o.image} alt={o.alt} />
              )}
              <span className="choice-body">
                <span className="choice-box" aria-hidden="true" />
                <span>
                  <b>{o.label}</b>
                  <small>{o.hint}</small>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
