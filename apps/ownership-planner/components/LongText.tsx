// components/LongText.tsx: a long message that does not take over a phone.
//
// On a small screen it shows the first couple of lines and a "Show details"
// toggle (a native <details>, so it needs no JavaScript and works with a
// keyboard and a screen reader). On a wide screen the whole message shows,
// exactly as before. Which form shows is the stylesheet's choice (.longtext in
// globals.css); the other is display:none, so it is not read out twice.

import { shortText, SHORT_TEXT_CHARS } from "@/lib/long-text";

export default function LongText({
  text,
  max = SHORT_TEXT_CHARS,
  className,
}: {
  text: string;
  max?: number;
  className?: string;
}) {
  const short = shortText(text, max);
  if (short === text.replace(/\s+/g, " ").trim()) return <span className={className}>{text}</span>;
  return (
    <span className={`longtext${className ? ` ${className}` : ""}`}>
      <span className="longtext-wide">{text}</span>
      <details className="longtext-narrow">
        <summary>
          <span className="longtext-short">{short}</span>{" "}
          <span className="longtext-toggle longtext-toggle--show">Show details</span>
          <span className="longtext-toggle longtext-toggle--hide">Hide details</span>
        </summary>
        <span className="longtext-full">{text}</span>
      </details>
    </span>
  );
}
