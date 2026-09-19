// app/plan/[sessionId]/page.tsx
//
// Server component. Loads the session through the Edge layer, which is the only
// thing holding FNI_WEBHOOK_SECRET, and renders the shell around the client
// planner. The browser never learns the secret and never touches Supabase.

import { edge, EdgeError, isSessionId } from "@/lib/edge";
import type { SessionPayload } from "@/lib/types";
import Planner from "./Planner";
import Gate from "./Gate";

export const dynamic = "force-dynamic";

export default async function PlanPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  // Refuse anything that is not a well-formed UUID before it reaches an Edge
  // Function. Indistinguishable from "not found", deliberately.
  if (!isSessionId(sessionId)) {
    return (
      <Gate
        title="We couldn't find this plan"
        body="This link doesn't look right. Ask the dealership to send you a new one — it takes them one click."
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
          title="This plan has expired"
          body="For your privacy, planning links stop working after a while. Ask the dealership to start a new one — it takes them one click and nothing is lost."
        />
      );
    }
    if (err instanceof EdgeError && err.status === 404) {
      return (
        <Gate
          title="We couldn't find this plan"
          body="This link may have been mistyped. Ask the dealership to send you a new one."
        />
      );
    }
    console.error("plan page load failed:", err);
    return (
      <Gate
        title="We can't load this right now"
        body="Something went wrong on our side. Please try again in a moment, or ask the dealership for help."
      />
    );
  }

  return <Planner initial={payload} />;
}
