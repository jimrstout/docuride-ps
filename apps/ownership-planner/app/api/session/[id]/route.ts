// GET /api/session/:id -> fni-session-get
import { edge } from "@/lib/edge";
import { edgeFailure, noStore, requireSessionId } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const check = requireSessionId(id);
  if (!check.ok) return check.response;

  try {
    return noStore(await edge.sessionGet(check.id));
  } catch (err) {
    return edgeFailure(err);
  }
}
