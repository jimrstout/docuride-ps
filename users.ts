import type { VercelRequest, VercelResponse } from "@vercel/node";

/*
 * Admin user management.
 *  GET  /api/admin/users            → list users
 *  POST /api/admin/users {email}    → send invite email
 * Auth: Authorization: Bearer <Supabase user access token>
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ADMIN_URL = process.env.ADMIN_URL ?? "https://www.docuride.com/admin";

async function caller(req: VercelRequest): Promise<string | null> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: auth },
  });
  if (!r.ok) return null;
  const u = (await r.json()) as { email?: string };
  return u.email ?? null;
}

const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const who = await caller(req);
  if (!who) return res.status(401).json({ error: "Sign in required" });

  if (req.method === "GET") {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, { headers: svc });
    const j = (await r.json()) as { users?: Array<Record<string, unknown>> };
    const users = (j.users ?? []).map((u) => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      invited_at: u.invited_at,
      confirmed: Boolean(u.email_confirmed_at),
    }));
    return res.status(200).json({ users });
  }

  if (req.method === "POST") {
    const email = String((req.body ?? {}).email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email" });
    const r = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
      method: "POST",
      headers: svc,
      body: JSON.stringify({ email, data: { invited_by: who }, redirect_to: ADMIN_URL }),
    });
    const j = (await r.json()) as { msg?: string; message?: string; error_description?: string };
    if (!r.ok) return res.status(r.status).json({ error: j.msg ?? j.message ?? j.error_description ?? "Invite failed" });
    return res.status(200).json({ ok: true, email });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
