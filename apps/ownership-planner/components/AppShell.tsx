// The frame every customer-facing screen sits in.
//
// DocuRide PS is the product identity; the dealership's name sits alongside it
// rather than instead of it. Both the planner and the states where there is no
// plan to show use this, so a mistyped link lands somewhere that plainly
// belongs to the same application.

export default function AppShell({
  stepper,
  rail,
  children,
  footer,
}: {
  stepper?: React.ReactNode;
  rail?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">⌃⌃</span>
          <span className="brand-name">
            <b>DocuRide PS</b>
            <small>Protection &amp; Support</small>
          </span>
        </div>

        {stepper}

        <p className="strapline">
          A better<br />ownership<br />experience
          <i aria-hidden="true" />
        </p>
      </header>

      <div className={`frame ${rail ? "" : "frame--full"}`}>
        {rail}
        <main className="stage">
          <div className="stage-inner">{children}</div>
          {footer}
        </main>
      </div>

      <footer className="colophon">
        <p className="colophon-brand">
          <b>All Seasons</b>
          <small>Powersports &amp; Equipment</small>
        </p>
        <p><b>Local expertise</b><span>People who ride, work and live here.</span></p>
        <p><b>Long-term support</b><span>Service, parts and expertise.</span></p>
        <p><b>Stronger communities</b><span>Riders, workers and neighbors just like you.</span></p>
      </footer>
    </div>
  );
}
