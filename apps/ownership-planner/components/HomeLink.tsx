// components/HomeLink.tsx: "DocuRide PS", linking to the main screen.
//
// The first crumb of every staff page's top bar (Details, the admin area), so
// there is always one way home. The main screen is "/", which opens the
// session browser. Staff pages only: the customer's menu presentation never
// shows it.

import Control from "@/components/Control";

// The Sessions page itself, not "/", which only redirects there: a redirect
// is a second trip to the server before the page can be drawn.
export const HOME_HREF = "/admin/sessions";

export default function HomeLink() {
  return (
    <Control href={HOME_HREF} className="home-link" title="Back to the DocuRide PS main screen">
      DocuRide <span>PS</span>
    </Control>
  );
}
