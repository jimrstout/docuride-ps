// Include, or I'll manage this.
//
// Both are real decisions and they are drawn with equal weight. Neither is
// pre-selected, neither is styled as the default, and the one the customer did
// not take is never called declined, rejected or unprotected anywhere in the
// interface. Someone who chooses to carry a cost themselves has made a
// legitimate choice, and a screen that shames them for it is both worse
// practice and worse product.
//
// A radiogroup rather than two toggles, because the two answers are the two
// values of one question. That carries an obligation: a radiogroup is expected
// to be one tab stop with the arrows moving between options, so it implements
// that rather than claiming the role and leaving the keyboard behaviour of two
// plain buttons underneath it.

"use client";

import { useRef } from "react";
import type { Disposition } from "@/lib/types";

const OPTIONS: { d: Disposition; label: string }[] = [
  { d: "Included", label: "Include" },
  { d: "Managed by Customer", label: "I'll manage this" },
];

export default function DecisionControl({
  name,
  value,
  onChange,
  productName,
}: {
  name: string;
  value: Disposition | undefined;
  onChange: (d: Disposition) => void;
  /** Named in the group label, so the choice is unambiguous read aloud. */
  productName: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, delta: number) => {
    const to = (from + delta + OPTIONS.length) % OPTIONS.length;
    refs.current[to]?.focus();
    onChange(OPTIONS[to].d);
  };

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault(); move(i, 1); break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault(); move(i, -1); break;
      case "Home":
        e.preventDefault(); move(i, -i); break;
      case "End":
        e.preventDefault(); move(i, OPTIONS.length - 1 - i); break;
    }
  };

  // Nothing is chosen yet, so the group is entered at the first option. Once a
  // decision exists the chosen one is the tab stop, which is what lets a
  // customer tab back to it and see where they are.
  const activeIndex = Math.max(0, OPTIONS.findIndex((o) => o.d === value));

  return (
    <div
      className="decision"
      role="radiogroup"
      aria-label={`Your decision about ${productName}`}
    >
      {OPTIONS.map((o, i) => {
        const on = value === o.d;
        return (
          <button
            key={o.d}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === activeIndex ? 0 : -1}
            name={name}
            className={`decision-option ${on ? "is-chosen" : ""}`}
            onClick={() => onChange(o.d)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className="decision-mark" aria-hidden="true" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
