// fni-documents-generated/index.ts
//
// The CRM calls this each time a deal's documents are generated (the Deluge
// function that starts Generate). See _shared/documents-generated.ts for why.
//
// POST, header x-webhook-secret: <FNI_WEBHOOK_SECRET>, JSON:
//   { "zoho_deal_id": "<CRM record id>", "initiated_by": "<who pressed Generate>" }
//
//   no session for the deal        200 "No F&I session for this deal, nothing to file."
//   no Deal Jacket folder ID yet   200 "Folders not created yet." A first
//                                  Generate: zoho-sync files the contracts when
//                                  the Flow writes the folder IDs.
//   a Deal Jacket folder ID        200 at once, then in the background every
//                                  contract document PS holds for the session
//                                  is filed again (_shared/deal-jacket-file.ts,
//                                  refileAfterRegenerate): a same-named file in
//                                  the Deal Jacket goes to the trash and the
//                                  document is uploaded, as Get document does;
//                                  one missing is added; VOID stays in a voided
//                                  contract's name. Each is claimed first
//                                  (filing_started_at), so a zoho-sync filing
//                                  and a regenerate never file one at once.
//
// The answer: { session_found, folders_known, contracts_queued, message }.
// Session event when done: "Contracts filed to Deal Jacket after documents
// were regenerated" with the count, signed with initiated_by's initials or
// System; one "Contract not filed to Deal Jacket" per contract that failed.
//
// No provider is called. Never logs the secret, a folder ID, a name or a file
// name: session ids, counts and statuses only.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { dcDealFolders } from "../_shared/dc-deal-folders.ts";
import { heldDocuments, refileAfterRegenerate } from "../_shared/deal-jacket-file.ts";
import { resolveFolders } from "../_shared/deal-jacket-request.ts";
import {
  NO_FOLDERS,
  NO_SESSION,
  initialsOf,
  parseGenerated,
  queuedMessage,
  type GeneratedReply,
} from "../_shared/documents-generated.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = new URL(req.url);
  const presented = req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  const configured = Deno.env.get("FNI_WEBHOOK_SECRET");
  if (!secretsMatch(presented, configured)) {
    // Lengths and presence only, never the values.
    console.warn("fni-documents-generated auth failed", {
      configuredLength: configured?.length ?? 0,
      presentedLength: presented?.length ?? 0,
    });
    return json(401, { error: "Unauthorized" });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const parsed = parseGenerated(body);
  if ("error" in parsed) return json(400, { error: parsed.error });
  const { zoho_deal_id, initiated_by } = parsed.request;

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    // ── The deal's session ───────────────────────────────────────────────
    const { data: session, error } = await supabase
      .schema("fni")
      .from("sessions")
      .select("id, zoho_deal_id, deal_number, deal_jacket_folder_id, signed_documents_folder_id")
      .eq("zoho_deal_id", zoho_deal_id)
      .maybeSingle();
    if (error) return json(500, { error: `The deal's session could not be read (${error.code ?? "error"}).` });
    const s = session as {
      id: string; zoho_deal_id: string | null; deal_number: string | null;
      deal_jacket_folder_id: string | null; signed_documents_folder_id: string | null;
    } | null;

    if (!s) {
      const reply: GeneratedReply = { session_found: false, folders_known: false, contracts_queued: 0, message: NO_SESSION };
      return json(200, reply);
    }

    // ── A first Generate: zoho-sync files when the folder IDs arrive ─────
    if (!s.deal_jacket_folder_id) {
      console.log("fni-documents-generated", { session: s.id, outcome: "folders not created yet" });
      const reply: GeneratedReply = { session_found: true, folders_known: false, contracts_queued: 0, message: NO_FOLDERS };
      return json(200, reply);
    }

    // ── A regenerate: file every held document again ─────────────────────
    // The session's folders first; dc.deals only for a Signed Documents ID
    // the session does not have yet.
    const dc = s.signed_documents_folder_id ? null : await dcDealFolders(s.zoho_deal_id, s.deal_number).catch(() => null);
    const resolved = resolveFolders({ deal_jacket_folder_id: null, signed_documents_folder_id: null }, dc, s);
    if (!resolved) {
      console.log("fni-documents-generated", { session: s.id, outcome: "signed documents folder not known" });
      const reply: GeneratedReply = { session_found: true, folders_known: false, contracts_queued: 0, message: NO_FOLDERS };
      return json(200, reply);
    }

    const held = (await heldDocuments(supabase, [s.id])).filter((d) => d.document_storage_path && d.document_name);
    if (held.length > 0) {
      const work = refileAfterRegenerate(supabase, s.id, resolved.folders, initialsOf(initiated_by)).catch((err) =>
        console.error("fni-documents-generated refile failed", err instanceof Error ? err.message : String(err))
      );
      // Answered first; the filing runs after. Awaited only where there is no
      // runtime to keep it alive (a local run).
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
      else await work;
    }

    console.log("fni-documents-generated", { session: s.id, outcome: "regenerated", queued: held.length });
    const reply: GeneratedReply = {
      session_found: true,
      folders_known: true,
      contracts_queued: held.length,
      message: queuedMessage(held.length),
    };
    return json(200, reply);
  } catch (err) {
    console.error("fni-documents-generated error:", err instanceof Error ? err.message : String(err));
    return json(500, { error: "The documents could not be filed just now. Nothing was deleted. Try again shortly." });
  }
});
