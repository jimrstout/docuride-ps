// The end of the journey.
//
// Rewarding but restrained, and honest about where the plan has got to: it
// says the record has been prepared, not that anything has been signed, and
// every action offered is one the application can actually perform. A button
// that does nothing at the moment a customer finishes is the worst place in
// the flow to put one.
//
// The arc closes here. "What's next" stays deliberately vague -- someone who
// bought a machine an hour ago does not need to be pointed at trading it.

export default function CompletionState({
  vehicleName,
  term,
  children,
}: {
  vehicleName: string;
  term: number | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="done done--split">
      <div>
        <p className="done-mark" aria-hidden="true">⌃⌃</p>
        <h1 className="done-head">You bought something worth owning.</h1>
        <p className="done-sub">Let&apos;s help you own it well.</p>

        <ol className="arc" aria-label="Where this plan sits">
          <li>
            <span className="arc-when">Today</span>
            <span className="arc-what">{vehicleName || "Your machine"} is yours.</span>
          </li>
          <li className="arc-now" aria-current="step">
            <span className="arc-when">Your ownership</span>
            <span className="arc-what">
              {term !== null ? `The next ${term} months of using it.` : "The years you'll spend using it."}
            </span>
          </li>
          <li>
            <span className="arc-when">What&apos;s next</span>
            <span className="arc-what">More life ahead.</span>
          </li>
        </ol>
      </div>

      <div>{children}</div>
    </div>
  );
}
