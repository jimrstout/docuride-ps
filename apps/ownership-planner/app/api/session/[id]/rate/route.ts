// POST /api/session/:id/rate
//
// Asks TecAssured for this session's menu, if nobody has asked yet.
//
// ── Why this route exists (2026-09-26) ──────────────────────────────────
// It is the caller that was missing. /api/rate had been in the tree since the
// rating work landed and NOTHING in the planner ever called it, so no live
// session was ever rated: the customer opened the planner, fni-session-get
// found no row in fni.rated_offers, and the Care & Protection step concluded
// that plans were not offered on their machine. Deal 14132, a Can-Am Defender
// correctly mapped to UTV, read exactly that. The Edge logs for it show
// zoho-sync, fni-session-start, two fni-session-get and four fni-session-save,
// and no fni-rate-vehicle at all.
//
// ── Once, not on every load ─────────────────────────────────────────────
// It fires only from "Pending", which means no attempt has ever been recorded.
// The moment fni-rate-vehicle records an outcome -- Rated, Not Offered or
// Failed -- this route declines to ask again, so a reload cannot turn a broken
// deal into a stream of provider calls. Re-rating after staff fix something is
// a deliberate act with its own button on the console, not a side effect of
// somebody refreshing a page.
//
// The rating itself is the Edge Function's job. This holds the secret, decides
// whether to ask, and reports the outcome in the vocabulary of the states.

import { edge, EdgeError } from "@/lib/edge";
import type { SessionPayload } from "@/lib/types";
import { edgeFailure, noStore, requireSessionId } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/** How the outcome reads back to the planner. Never the reason. */
type Outcome = "Rated" | "Not Offered" | "Failed" | "Skipped";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const check = requireSessionId(id);
  if (!check.ok) return check.response;

  try {
    const before = await edge.sessionGet<SessionPayload>(check.id);
    const state = before.offer_status?.state ?? "Pending";

    // Already asked. Whatever the answer was, it stands until someone re-rates
    // on purpose.
    if (state !== "Pending") {
      return noStore({ outcome: "Skipped" as Outcome, state });
    }

    try {
      const result = await edge.rate<{ product_count?: number; status?: string }>({
        session_id: check.id,
      });

      const count = typeof result.product_count === "number" ? result.product_count : 0;
      return noStore({
        outcome: (count > 0 ? "Rated" : "Not Offered") satisfies Outcome,
        product_count: count,
      });
    } catch (err) {
      // fni-rate-vehicle has already written the Failed row and the reason, so
      // there is nothing to record here. The reason is deliberately NOT echoed
      // to the browser: it names missing fields and quotes the provider, and
      // the planner has neutral copy for exactly this case.
      const detail =
        err instanceof EdgeError ? `${err.status} ${err.message}` : String(err);
      console.error(
        `FNI_RATE_FAILED session=${check.id} deal=${before.session.deal_number ?? "?"} ` +
          `vtype=${before.session.vehicle.tecassured_code ?? "none"} detail=${JSON.stringify(detail)}`
      );
      return noStore({ outcome: "Failed" as Outcome });
    }
  } catch (err) {
    return edgeFailure(err);
  }
}
