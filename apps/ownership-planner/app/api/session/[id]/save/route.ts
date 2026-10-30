// POST /api/session/:id/save -> fni-session-save
import { edge } from "@/lib/edge";
import { edgeFailure, noStore, requireSessionId } from "@/lib/route-helpers";
import { presenter } from "@/lib/presenter";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const check = requireSessionId(id);
  if (!check.ok) return check.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return noStore({ error: "Invalid JSON body" }, 400);
  }

  // The path is authoritative. A body that names a different session is a bug
  // or an attempt to write across sessions; either way the path wins. Who is
  // presenting comes from this browser's console cookie, never from the body.
  const { presented_by: _by, presented_by_name: _name, ...rest } = body;
  try {
    return noStore(await edge.sessionSave({ ...rest, ...(await presenter()), session_id: check.id }));
  } catch (err) {
    return edgeFailure(err);
  }
}
