// app/menu/[sessionId]/page.tsx: the conventional menu.
//
// A second presentation beside the Ownership Planner, out of the same session
// (docs/multi-provider.md, section 22). It loads the same session payload
// through the Edge layer, which holds the secret, and opens straight into the
// package columns: none of the planner's screens come first. It opens in its
// own customer tab, like the planner, and has no link back to staff screens.
//
// An expired or unknown session reads exactly as it does on the planner. The
// rating's reason never crosses to the browser.

import { edge, EdgeError, isSessionId } from "@/lib/edge";
import type { SessionPayload } from "@/lib/types";
import Gate from "../../plan/[sessionId]/Gate";
import Menu from "./Menu";

export const dynamic = "force-dynamic";

const EYEBROW = "Protection menu";

export default async function MenuPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;

  if (!isSessionId(sessionId)) {
    return (
      <Gate
        eyebrow={EYEBROW}
        title="We couldn't find this menu"
        body="This link doesn't look right. Ask the dealership to open it again. It takes them one click."
      />
    );
  }

  let payload: SessionPayload;
  try {
    payload = await edge.sessionGet<SessionPayload>(sessionId);
  } catch (err) {
    if (err instanceof EdgeError && err.status === 410) {
      return (
        <Gate
          eyebrow={EYEBROW}
          title="This menu has expired"
          body="For your privacy, these links stop working after a while. Ask the dealership to open a new one. Nothing is lost."
        />
      );
    }
    if (err instanceof EdgeError && err.status === 404) {
      return <Gate eyebrow={EYEBROW} title="We couldn't find this menu" body="Ask the dealership to open it again." />;
    }
    console.error("menu page load failed:", { session: sessionId });
    return (
      <Gate
        eyebrow={EYEBROW}
        title="We can't load this right now"
        body="Something went wrong on our side. Please try again in a moment, or ask the dealership for help."
      />
    );
  }

  // The rating's reason is for staff, and never reaches the customer's tab.
  const safe: SessionPayload = payload.offer_status
    ? { ...payload, offer_status: { ...payload.offer_status, detail: null } }
    : payload;

  return <Menu initial={safe} />;
}
