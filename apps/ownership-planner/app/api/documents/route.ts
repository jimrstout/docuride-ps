// POST /api/documents -> fni-contract-documents
// Blocked until TecAssured credentials land; no UI change needed when they do.
import { edge } from "@/lib/edge";
import { edgeFailure, noStore, requireSessionId } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return noStore({ error: "Invalid JSON body" }, 400);
  }

  const check = requireSessionId(body.session_id as string | undefined);
  if (!check.ok) return check.response;

  try {
    return noStore(await edge.documents({ ...body, session_id: check.id }));
  } catch (err) {
    return edgeFailure(err);
  }
}
