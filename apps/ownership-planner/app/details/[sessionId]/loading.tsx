// app/details/[sessionId]/loading.tsx: Details while its data is on the way.
//
// Without this, an action on Details that answers by reloading Details (Rate,
// Save changes, Refresh from CRM, Void and the rest) left the window blank for
// as long as the new page took to read the deal: Next draws an empty page in
// that gap, and the busy overlay went with it. Measured with slowed answers,
// three seconds of white with no sign anything was happening.
//
// Now the gap shows this: still busy, saying so, until the deal is drawn.
// The page change and the action's busy state both carry on through it and
// end only once Details itself is on the screen (components/NavBusy.tsx,
// components/Working.tsx).

export default function DetailsLoading() {
  return (
    <div className="page-loading" data-page-loading="" role="status" aria-live="polite">
      <span className="working-spinner" aria-hidden="true" />
      <p>Loading the deal...</p>
    </div>
  );
}
