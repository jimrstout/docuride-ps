// POST /api/session/:id/photos
//
// Looks up the customer's actual machine by VIN and caches the result on the
// session row, so stepping backward and forward through the planner does not
// trigger repeated lookups.
//
// Runs server-side only. DX1 credentials never reach client code.
import { edge } from "@/lib/edge";
import { fetchPhotos } from "@/lib/dx1";
import type { SessionPayload } from "@/lib/types";
import { edgeFailure, noStore, requireSessionId } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/** Re-look-up a cached-empty result occasionally; photos get added late. */
const EMPTY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const check = requireSessionId(id);
  if (!check.ok) return check.response;

  try {
    const payload = await edge.sessionGet<SessionPayload>(check.id);

    const cached = payload.photos;
    const cachedAt = payload.photos_cached_at
      ? Date.parse(payload.photos_cached_at)
      : null;

    // A cached hit is final. A cached empty is retried after a while, because a
    // unit photographed the day after delivery should eventually show up.
    const cacheUsable =
      Array.isArray(cached) &&
      (cached.length > 0 ||
        (cachedAt !== null && Date.now() - cachedAt < EMPTY_CACHE_TTL_MS));

    if (cacheUsable) {
      return noStore({ photos: cached, cached: true });
    }

    const result = await fetchPhotos(payload.session.vehicle.vin);

    // Cache the empty result too. "Looked up, none exist" is an answer, and
    // re-asking on every render is not free.
    await edge.sessionSave({
      session_id: check.id,
      dx1_photos: result.photos,
    });

    return noStore({
      photos: result.photos,
      cached: false,
      unavailable_reason: result.unavailable_reason,
    });
  } catch (err) {
    return edgeFailure(err);
  }
}
