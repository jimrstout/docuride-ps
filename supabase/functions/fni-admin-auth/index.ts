// fni-admin-auth/index.ts
//
// Who may open the internal session browser.
//
// The codebase already has an admin login: admin.html signs in against Supabase
// Auth with an email and password, and 0002_platform_admin added
// profiles.is_platform_admin for the people who run DocuRide as opposed to the
// people who work at a dealership. This reuses both, so the console has no
// credential of its own to set, rotate or leak, and revoking someone is still
// one change in one place.
//
// Input (POST): { email, password }
// Auth: FNI_WEBHOOK_SECRET via x-webhook-secret header or ?secret=.
//
// The password check runs here rather than in the Next server layer for the
// same reason every other check does (ARCHITECTURE.md): the Vercel side holds
// no Supabase key beyond the relay's, and business rules -- "a platform admin,
// not merely a valid login" -- belong where the service role already is.
//
// Returns 200 { user_id, email } or 401 { error }. A wrong password, an unknown
// address and a real dealership user who is not a platform admin all return the
// same 401 with the same message: telling them apart turns this into a way to
// enumerate who has an account.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

const DENIED = { error: "Those details don't match an account with access." };

serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = new URL(req.url);
  const presented =
    req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  if (!secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "A JSON body is required" });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return json(400, { error: "Email and password are required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

  // The password grant needs a project key in apikey. The anon key is injected
  // into every Edge Function and is the right one -- it is the same key
  // admin.html presents from the browser. The service role is accepted by the
  // gateway too, but sending the key that bypasses RLS on a request that does
  // not need it is a habit worth not having.
  const apiKey =
    Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    const grant = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!grant.ok) {
      // GoTrue rate-limits this endpoint per IP, which is the brute-force
      // control; 429 is forwarded so the console can say so rather than
      // claiming the password is wrong.
      if (grant.status === 429) {
        return json(429, { error: "Too many attempts. Wait a minute and try again." });
      }
      return json(401, DENIED);
    }

    const session = (await grant.json()) as {
      access_token?: string;
      user?: { id?: string; email?: string };
    };

    const userId = session.user?.id;
    const accessToken = session.access_token;
    if (!userId || !accessToken) return json(401, DENIED);

    // The grant leaves a refresh token behind that nothing will ever use: the
    // console carries its own short-lived cookie, not a Supabase session. Retire
    // it rather than accumulating one per sign-in.
    const retire = fetch(`${supabaseUrl}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: apiKey, Authorization: `Bearer ${accessToken}` },
    }).catch(() => {
      // A refresh token that outlives its usefulness is untidy, not unsafe.
      // It must never cost a valid operator their sign-in.
    });

    const supabase = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("is_platform_admin")
      .eq("user_id", userId)
      .maybeSingle();

    await retire;

    if (error) {
      console.error("fni-admin-auth profile read failed:", error.message);
      return json(500, { error: "Could not check access" });
    }

    // A valid dealership login is not access to a cross-tenant list of every
    // session. Platform admin is the existing flag for exactly that
    // distinction, so it is the one used here.
    if (!profile || (profile as { is_platform_admin: boolean }).is_platform_admin !== true) {
      console.warn(`fni-admin-auth refused non-admin sign-in for ${userId}`);
      return json(401, DENIED);
    }

    return json(200, { user_id: userId, email: session.user?.email ?? email });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-admin-auth error:", message);
    return json(500, { error: "Could not sign in right now" });
  }
});
