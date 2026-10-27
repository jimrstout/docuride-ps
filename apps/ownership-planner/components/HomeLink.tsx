// components/HomeLink.tsx: "DocuRide PS", linking to the main screen.
//
// The first crumb of every staff page's top bar (Details, the admin area), so
// there is always one way home. The main screen is "/", which opens the
// session browser. Staff pages only: the customer's menu presentation never
// shows it.

import Link from "next/link";

export const HOME_HREF = "/";

export default function HomeLink() {
  return (
    <Link href={HOME_HREF} prefetch={false} className="home-link" title="Back to the DocuRide PS main screen">
      DocuRide <span>PS</span>
    </Link>
  );
}
