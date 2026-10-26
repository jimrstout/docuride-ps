// fni-documents-to-deal-jacket/index.ts
//
// Moves a deal's held contract documents into its WorkDrive Deal Jacket, once
// DocuRide DC has made the deal's folders. Called by a CRM Deluge function
// right after the folders are created, and by Verify's "Move documents to
// Deal Jacket" button. See docs/multi-provider.md, section 13, for the call.
//
// POST, header x-webhook-secret: <FNI_WEBHOOK_SECRET> (or ?secret=), JSON:
//   { "record_id": "4742556000231058020",          // or "deal_number": "13759"
//     "deal_jacket_folder_id": "...",              // optional
//     "signed_documents_folder_id": "..." }        // optional
//
// ── What it does ─────────────────────────────────────────────────────────
//   1. Finds the deal's DocuRide sessions, by Zoho record id or deal number.
//   2. Takes the folders: ids sent with the call win, otherwise dc.deals.
//      Neither has them: "Missing Folder", and nothing is changed.
//   3. For every document PS holds for those sessions that is not in the Deal
//      Jacket yet ("Waiting for Deal Jacket", or "Voided" before it moved):
//      builds its full name, moves any same-named file in the Deal Jacket to
//      the WorkDrive trash, uploads the PDF from the fni-contracts bucket, and
//      records it "Saved to Deal Jacket". A voided one lands with " VOID"
//      before the first pipe. See _shared/deal-jacket-move.ts.
//   4. Answers with each file name and what happened to it.
//
// Safe to call any number of times: a document already in the Deal Jacket is
// skipped. No provider is called, so the QA-only contract rule does not apply;
// only documents PS already holds are ever moved. The bucket copy is kept and
// nothing is deleted. Never logs the secret, a buyer's name or a file name.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { dcDealFolders } from "../_shared/dc-deal-folders.ts";
import { liveMoveDeps } from "../_shared/deal-jacket-live.ts";
import { moveHeldDocuments, type HeldDocument } from "../_shared/deal-jacket-move.ts";
import { MISSING_FOLDER_MESSAGE, parseMoveRequest, resolveFolders } from "../_shared/deal-jacket-request.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = new URL(req.url);
  const presented = url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
  if (!secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const parsed = parseMoveRequest(body);
  if ("error" in parsed) return json(400, { error: parsed.error });
  const request = parsed.request;

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    // ── 1. The deal's sessions ───────────────────────────────────────────
    let q = supabase.schema("fni").from("sessions").select("id, deal_number, zoho_deal_id");
    q = request.session_id
      ? q.eq("id", request.session_id)
      : request.record_id
        ? q.eq("zoho_deal_id", request.record_id)
        : q.eq("deal_number", request.deal_number!);
    const { data: sessions, error: sessErr } = await q;
    if (sessErr) return json(500, { error: `The deal's sessions could not be read (${sessErr.code ?? "error"}).` });
    const found = (sessions ?? []) as { id: string; deal_number: string | null; zoho_deal_id: string | null }[];
    if (found.length === 0) {
      return json(404, { error: "DocuRide has no planning session for this deal, so it holds no documents for it. Nothing changed.", files: [] });
    }
    const recordId = request.record_id ?? found.find((s) => s.zoho_deal_id)?.zoho_deal_id ?? null;
    const dealNumber = request.deal_number ?? found.find((s) => s.deal_number)?.deal_number ?? null;

    // ── 2. The folders ───────────────────────────────────────────────────
    const dc = await dcDealFolders(recordId, dealNumber);
    const resolved = resolveFolders(request, dc);
    if (!resolved) {
      return json(409, { error: MISSING_FOLDER_MESSAGE, reason: "Missing Folder", deal_number: dealNumber, files: [] });
    }

    // ── 3. The documents PS holds for the deal ───────────────────────────
    const { data: agreements } = await supabase
      .schema("fni")
      .from("agreements")
      .select("id")
      .in("session_id", found.map((s) => s.id));
    const agreementIds = ((agreements ?? []) as { id: string }[]).map((a) => a.id);
    let docs: HeldDocument[] = [];
    if (agreementIds.length > 0) {
      const { data: rows, error: rowErr } = await supabase
        .schema("fni")
        .from("agreement_products")
        .select("id, contract_number, document_name, document_storage_path, document_status, workdrive_file_id, document_position")
        .in("agreement_id", agreementIds)
        .is("recorded_by", null)
        .not("document_storage_path", "is", null)
        .order("document_position", { ascending: true, nullsFirst: false });
      if (rowErr) return json(500, { error: `The deal's documents could not be read (${rowErr.code ?? "error"}).` });
      docs = (rows ?? []) as unknown as HeldDocument[];
    }

    const lines = await moveHeldDocuments(docs, resolved.folders, liveMoveDeps(supabase));
    const moved = lines.filter((l) => l.moved).length;
    console.log("fni-documents-to-deal-jacket", { sessions: found.length, documents: lines.length, moved, folders_from: resolved.source });

    return json(200, {
      deal_number: dealNumber,
      folders_from: resolved.source,
      moved_count: moved,
      message:
        lines.length === 0
          ? "DocuRide holds no contract documents for this deal yet. Nothing changed."
          : `${moved} of ${lines.length} ${lines.length === 1 ? "document was" : "documents were"} moved to the Deal Jacket.`,
      files: lines.map((l) => ({ contract_number: l.contract_number, file_name: l.file_name, outcome: l.outcome })),
    });
  } catch (err) {
    console.error("fni-documents-to-deal-jacket error:", err instanceof Error ? err.message : String(err));
    return json(500, { error: "The documents could not be moved just now. Nothing was deleted. Try again shortly." });
  }
});
