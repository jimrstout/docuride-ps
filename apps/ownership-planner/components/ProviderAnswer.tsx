// components/ProviderAnswer.tsx: what the provider said to a submit that did
// not simply succeed.
//
// fni-contract-submit keeps the provider's HTTP status, request ID and body,
// with personal details taken out (supabase/functions/_shared/provider-answer.ts).
// Shown behind "Show details", with "Copy error", the way a failed rating is
// (components/RatingErrorText.tsx), so staff can read it and send it to the
// provider.

import RatingErrorText from "@/components/RatingErrorText";

export default function ProviderAnswer({
  deal,
  provider,
  answer,
  lead,
}: {
  deal: string | null | undefined;
  /** The provider's name from its record, as a sentence starts with it. */
  provider: string;
  answer: { at: string; kind: string; text: string };
  /** What the line before Show details says. */
  lead: string;
}) {
  return (
    <div className="provider-answer">
      <p className="vfield-note">{lead}</p>
      <details className="rating-banner-more">
        <summary>
          <span className="rating-banner-toggle rating-banner-toggle--show">Show details</span>
          <span className="rating-banner-toggle rating-banner-toggle--hide">Hide details</span>
        </summary>
        <RatingErrorText deal={deal} failures={[{ provider, text: answer.text, at: answer.at }]} />
      </details>
    </div>
  );
}
