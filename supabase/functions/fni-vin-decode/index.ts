// fni-vin-decode/index.ts
//
// Ask TecAssured what a VIN is, and record the answer on the session.
//
// ── Why its own function ─────────────────────────────────────────────────
// This was an action on fni-session-verify. It was the only thing that function
// did which talked to the provider, and it made the Verify sheet endpoint bundle
// the whole TecAssured client -- authentication, the PBKDF2 token, the session
// cache, all nine endpoints -- to serve a button nobody presses on most deals.
//
// That is 23 KB on every deploy of a function whose other four actions touch only
// Postgres and Zoho, and these deploys are assembled by hand. Splitting it also
// draws the line in the right place: reading and correcting a deal is one job,
// and calling a provider is another.
//
// Input (POST JSON):
//   session_id  - fni.sessions id (required)
//
// Auth: FNI_WEBHOOK_SECRET, as every other fni function.
//
// It returns the decode, not the sheet. The caller re-reads the sheet afterwards,
// which it was going to do anyway, and this function stays out of the business of
// knowing what a sheet looks like.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { createTecAssuredClient } from "../_shared/tecassured.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  const sessionId = body.session_id;
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
    return json(400, { error: "A well-formed session_id is required" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // Three columns, not the row. This function needs the VIN and the store and
    // nothing else, and a staff-facing endpoint that reads no PII cannot leak any.
    const { data: session } = await supabase
      .schema("fni")
      .from("sessions")
      .select("id, store_id, vin")
      .eq("id", sessionId)
      .maybeSingle();

    if (!session) return json(404, { error: "Session not found" });
    const s = session as { id: string; store_id: string; vin: string | null };

    const vin = typeof s.vin === "string" ? s.vin.trim() : "";
    if (vin === "") {
      return json(400, { error: "This deal has no VIN, so there is nothing to decode." });
    }

    let store;
    try {
      store = await createTecAssuredClient(s.store_id, supabase);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }

    let decoded: unknown;
    try {
      decoded = await store.client.decodePowersports(vin);
    } catch (err) {
      return json(502, {
        error: `TecAssured could not decode ${vin}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // A refusal comes back as HTTP 200 with an error string, as everywhere else in
    // this API, and an unsupported VIN comes back empty. Neither is cached: a
    // cached empty decode would read on the screen as "asked and there is nothing",
    // which would send a staff member looking for a field to type when the real
    // answer is that the call needs trying again.
    const decodeBody = (decoded ?? {}) as Record<string, unknown>;
    const refusal = typeof decodeBody.error === "string" ? decodeBody.error.trim() : "";
    if (refusal !== "") {
      return json(400, { error: `TecAssured could not decode ${vin}: ${refusal}` });
    }
    if (Object.keys(decodeBody).length === 0) {
      return json(400, {
        error:
          `TecAssured returned nothing for ${vin}. This dealer code may not support ` +
          `VIN decoding, or the VIN is not one it recognises. Type the engine size instead.`,
      });
    }

    const decodedAt = new Date().toISOString();
    const { error } = await supabase
      .schema("fni")
      .from("sessions")
      .update({ vin_decode: decodeBody, vin_decode_at: decodedAt })
      .eq("id", s.id);

    if (error) return json(500, { error: error.message });

    return json(200, {
      session_id: s.id,
      vin,
      decoded: true,
      vin_decode: decodeBody,
      vin_decode_at: decodedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-vin-decode error:", message);
    return json(500, { error: message });
  }
});
