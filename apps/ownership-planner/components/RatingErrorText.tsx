// components/RatingErrorText.tsx: a failed rating's full text, for staff.
//
// Behind "Show details" on the session list and on Details. Each failed
// provider's own words exactly as stored, in a box that scrolls rather than
// grows, with "Copy error" beside it (lib/rating-error.ts).

import CopyErrorButton from "@/components/CopyErrorButton";
import { copyErrorText, errorStamp, type RatingFailureText } from "@/lib/rating-error";

export default function RatingErrorText({
  deal,
  failures,
}: {
  deal: string | null | undefined;
  failures: RatingFailureText[];
}) {
  return (
    <div className="rating-error-full">
      {failures.map((f, i) => {
        const when = errorStamp(f.at);
        return (
          <div className="rating-error-item" key={`${f.provider}-${i}`}>
            <p className="rating-error-who">
              {f.provider}
              {when ? <span>, {when}</span> : null}
            </p>
            <pre className="rating-error-text" tabIndex={0}>{f.text}</pre>
            <CopyErrorButton text={copyErrorText(deal, f)} />
          </div>
        );
      })}
    </div>
  );
}
