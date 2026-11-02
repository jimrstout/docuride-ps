// _shared/staff-gate.ts: the staff sign-in check, wired to the database.
//
// The rule and the signature live in _shared/staff-auth.ts, which is pure and
// tested. This reads the two rows that rule needs, with the service role every
// function already has: the person's public.profiles row, and the deal's
// tenant and store from fni.sessions.
//
// Use it right after the FNI_WEBHOOK_SECRET check, before anything is read:
//
//   const refused = await staffGate(req, sessionId);   // one deal
//   const refused = await staffGate(req, null);        // admin area, no deal
//   if (refused) return refused;
//
// A refusal is a small JSON error and nothing else: no deal number, no buyer,
// no field. The CRM's own calls (the launch button, the Generate gate, filing
// documents) never reach this; they carry the webhook secret alone and are
// routed around it by the function that serves them.

import { decideStaff, STAFF_HEADER, type DealScope, type StaffProfile, type StaffSession } from "./staff-auth.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rest<T>(path: string, schema: "public" | "fni"): Promise<T[]> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": schema },
  });
  if (!r.ok) throw new Error(`staff gate read ${r.status}`);
  return (await r.json()) as T[];
}

async function profile(userId: string): Promise<StaffProfile | null> {
  if (!UUID.test(userId)) return null;
  const rows = await rest<StaffProfile>(
    `profiles?user_id=eq.${userId}&select=user_id,tenant_id,store_ids,is_platform_admin`,
    "public",
  );
  return rows[0] ?? null;
}

async function deal(sessionId: string): Promise<DealScope | null> {
  if (!UUID.test(sessionId)) return null;
  const rows = await rest<DealScope>(`sessions?id=eq.${sessionId}&select=tenant_id,store_id`, "fni");
  return rows[0] ?? null;
}

function refuse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

/** The signed-in staff member, for functions that record who did something. */
export type StaffGateOk = { staff: StaffSession; profile: StaffProfile };

/**
 * Null when the request carries a staff sign-in that covers `sessionId` (or,
 * with null, a platform admin's sign-in). Otherwise the Response to return.
 */
export async function staffGate(req: Request, sessionId: string | null): Promise<Response | null> {
  const result = await staffCheck(req, sessionId);
  return "response" in result ? result.response : null;
}

/** The same check, keeping who passed it. */
export async function staffCheck(
  req: Request,
  sessionId: string | null,
): Promise<StaffGateOk | { response: Response }> {
  try {
    const d = await decideStaff({
      token: req.headers.get(STAFF_HEADER),
      secret: Deno.env.get("FNI_WEBHOOK_SECRET"),
      profile,
      deal: sessionId === null ? null : () => deal(sessionId),
    });
    if (!d.ok) return { response: refuse(d.status, d.error) };
    return { staff: d.staff, profile: d.profile };
  } catch (err) {
    console.error("staff gate failed:", err instanceof Error ? err.message : String(err));
    return { response: refuse(503, "Sign-in could not be checked right now. Try again shortly.") };
  }
}
