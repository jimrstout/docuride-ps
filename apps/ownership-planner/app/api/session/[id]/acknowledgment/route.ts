// POST /api/session/:id/acknowledgment -> fni-acknowledgment
//
// Generates the record of what was presented and what the customer decided, and
// delivers it to the DocuRide record so it joins the existing Zoho Sign packet.
//
// Called when the customer completes the plan, before contract submit, so a
// failed submit still leaves a record. The Edge Function is idempotent: a retry
// whose signature line is already in the map uploads nothing.
import { edge } from "@/lib/edge";
import { edgeFailure, noStore, requireSessionId } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const check = requireSessionId(id);
  if (!check.ok) return check.response;

  try {
    const result = await edge.acknowledgment<Record<string, unknown>>({
      session_id: check.id,
    });

    // The PDF itself never needs to reach the browser -- it goes to the Deal
    // Jacket, and shipping a megabyte of base64 to a tablet on dealership wifi
    // helps nobody.
    const { pdf_base64: _pdf, ...rest } = result;
    return noStore(rest);
  } catch (err) {
    return edgeFailure(err);
  }
}
