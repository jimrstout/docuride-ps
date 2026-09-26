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
        body="This link doesn't look right. Ask the dealership to send you a new one. It takes them one click."
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
          body="For your privacy, planning links stop working after a while. Ask the dealership to start a new one. It takes them one click and nothing is lost."
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

  // ── The reason stays server-side ────────────────────────────────────────
  // offer_status.detail names the field that is missing, the provider's own
  // refusal text, or the mapping gap. That is exactly what staff need and
  // exactly what a customer should never read, and handing it to a client
  // component publishes it: props are serialised into the HTML.
  //
  // So it is logged here, where Vercel's runtime logs keep it, and removed from
  // what crosses to the browser. The staff console reads the same field from the
  // database, which is the copy staff actually go looking at.
  const status = payload.offer_status;
  if (status && status.state !== "Rated") {
    console.error(
      `FNI_RATE_NOT_READY session=${sessionId} deal=${payload.session.deal_number ?? "?"} ` +
        `vtype=${payload.session.vehicle.tecassured_code ?? "none"} state=${status.state} ` +
        `detail=${JSON.stringify(status.detail)}`
    );
  }

  const safe: SessionPayload = status
    ? { ...payload, offer_status: { ...status, detail: null } }
    : payload;

  return <Planner initial={safe} />;
}
