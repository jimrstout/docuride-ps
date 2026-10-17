// fni-price-sheet-parse/index.ts
//
// Read an uploaded price sheet with Claude. See docs/multi-provider.md, section 6.
//
// Auth: FNI_WEBHOOK_SECRET in the x-webhook-secret header. Only the admin
// area's server calls this, after its operator sign-in.
//
// POST { sheet_id, requested_by }
//
// Answers at once with the sheet marked Parsing, and reads it in the
// background: a long sheet takes longer than a request should wait. The admin
// page shows the outcome when it is done. The result is always a Draft.
//
// The key is DOCURIDE_PS_ANTHROPIC_API_KEY and nothing else. When it is not set
// this says so, naming the secret, and records the same sentence on the sheet.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { KEY_SECRET, MISSING_KEY_MESSAGE } from "../_shared/anthropic-price-sheet.ts";
import { parseSheet } from "../_shared/price-sheet-parse.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

serve(async (req: Request) => {
  if (!secretsMatch(req.headers.get("x-webhook-secret"), Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }
  if (req.method !== "POST") return json(405, { error: "POST only" });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const sheetId = body.sheet_id;
  if (typeof sheetId !== "string" || !UUID_RE.test(sheetId)) return json(400, { error: "Which sheet is missing." });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: sheet } = await supabase
    .schema("fni")
    .from("price_sheets")
    .select("id, name, status, parse_status")
    .eq("id", sheetId)
    .maybeSingle();
  const s = sheet as { id: string; name: string; status: string; parse_status: string } | null;
  if (!s) return json(404, { error: "That sheet no longer exists." });
  if (s.status !== "Draft") return json(409, { error: `"${s.name}" is ${s.status}. Only a Draft is read.` });
  if (s.parse_status === "Parsing") return json(409, { error: `"${s.name}" is being read now.` });

  // Read once. Reading again would replace rates someone may have reviewed, and
  // nothing here deletes them; a sheet is read again by uploading it again.
  const { count } = await supabase
    .schema("fni")
    .from("price_sheet_rates")
    .select("id", { count: "exact", head: true })
    .eq("sheet_id", s.id);
  if ((count ?? 0) > 0) {
    return json(409, { error: `"${s.name}" has already been read. Upload it again to read it again.` });
  }

  // The key is checked here so the person waiting is told at once. Its value is
  // never read into anything but the client that uses it.
  const key = Deno.env.get(KEY_SECRET);
  if (!key || key.trim() === "") {
    await supabase
      .schema("fni")
      .from("price_sheets")
      .update({ parse_status: "Parse Failed", parse_notes: MISSING_KEY_MESSAGE, updated_at: new Date().toISOString() })
      .eq("id", s.id);
    return json(400, { error: MISSING_KEY_MESSAGE });
  }

  await supabase
    .schema("fni")
    .from("price_sheets")
    .update({ parse_status: "Parsing", parse_notes: null, updated_at: new Date().toISOString() })
    .eq("id", s.id);

  const work = parseSheet(supabase, s.id);
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  else await work;

  return json(202, { sheet_id: s.id, parse_status: "Parsing" });
});
