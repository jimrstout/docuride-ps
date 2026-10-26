// fni-contract-documents/index.ts
//
// Pulls each contract's document from TecAssured, holds it in the private
// fni-contracts bucket, and, if the deal's WorkDrive folders already exist,
// saves it to the Deal Jacket as well. See docs/multi-provider.md, sections
// 12 and 13.
//
// Input (POST JSON):
//   session_id      - fni.sessions UUID (required)
//   agreement_id    - fni.agreements UUID (optional, defaults to latest)
//   contract_number - one contract (optional; every live contract if omitted)
//
// Auth: FNI_WEBHOOK_SECRET via ?secret= query param or x-webhook-secret header
//
// ── Before anything is asked of TecAssured ───────────────────────────────
//   • The QA-only rule (_shared/contract-guard.ts).
//   • The provider has a document prefix (Admin > Providers).
//   • There is a buyer name for the file: DocuRide DC's (dc.deals), or the
//     session's while the deal is not in DC yet.
//
// ── For each contract ────────────────────────────────────────────────────
//   1. Ask TecAssured for the document.
//   2. Keep exactly what it said: the signature data as returned, everything
//      else except the PDF, and the PDF's page count and page sizes in points.
//   3. Name it (_shared/document-names.ts): "TA01 MUI #13759 {buyer}
//      {product} {contract}". The routing part needs the Signed Documents
//      folder id, so the full name is built when the file reaches WorkDrive.
//   4. Hold the PDF in fni-contracts at {session id}/{file name}. The
//      document is "Waiting for Deal Jacket".
//   5. If dc.deals already has the deal's Deal Jacket and Signed Documents
//      folder, move it there now (_shared/deal-jacket-move.ts): "Saved to
//      Deal Jacket". If not, it waits, and fni-documents-to-deal-jacket moves
//      it once DocuRide DC has made the folders.
// Voided contracts and OEM contracts recorded by staff are left alone.
//
// No token or secret value is read, logged or returned, and nothing logs a
// buyer's name or a file name.
//
// Returns: { documents: [{ contract_number, file_name, document_status,
// workdrive_file_id, workdrive_url, page_count, error }], ... }. The PDF itself
// is not returned.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { createTecAssuredClient } from "../_shared/tecassured.ts";
import { secretsMatch } from "../_shared/supabase.ts";
import { contractCallRefusal } from "../_shared/contract-guard.ts";
import { assignPositions, buyerNameFor, prefixProblem, readyFolders } from "../_shared/contract-documents.ts";
import { documentBaseName, storageFileName } from "../_shared/document-names.ts";
import { fromBase64, isPdf, pageSizes, withoutPdf } from "../_shared/pdf-pages.ts";
import { dcDealFolders } from "../_shared/dc-deal-folders.ts";
import { HOLD_BUCKET, liveMoveDeps } from "../_shared/deal-jacket-live.ts";
import { moveHeldDocuments, WAITING } from "../_shared/deal-jacket-move.ts";
import { workDriveFileUrl } from "../_shared/workdrive-links.ts";

// ─── Types ───────────────────────────────────────────────────────────────

interface DocumentRequest {
  session_id: string;
  agreement_id?: string;
  contract_number?: string;
}

interface DocumentResult {
  contract_number: string;
  provider_product_id: string;
  file_name: string | null;
  document_status: string | null;
  workdrive_file_id: string | null;
  workdrive_url: string | null;
  page_count: number | null;
  error: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Main handler ────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = new URL(req.url);
  const presented = url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
  if (!secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }

  let body: DocumentRequest;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { session_id, agreement_id, contract_number } = body;
  if (!session_id) return json(400, { error: "session_id is required" });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    // ── Step 1: The session, the login, the rule ─────────────────────────
    const { data: session, error: sessErr } = await supabase
      .schema("fni")
      .from("sessions")
      .select("id, store_id, is_test, dealer_code_used, deal_number, zoho_deal_id, buyer_display_name")
      .eq("id", session_id)
      .single();
    if (sessErr || !session) return json(404, { error: `Session ${session_id} not found` });

    let store;
    try {
      store = await createTecAssuredClient(session.store_id, supabase);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
    const { client, dealerCode } = store;

    const notCleared = contractCallRefusal(session, store.credentials.api_base_url, "fetched");
    if (notCleared) return json(403, { error: notCleared });

    // Documents are fetched as the dealer that submitted the contract.
    if (session.dealer_code_used && session.dealer_code_used !== dealerCode) {
      return json(409, {
        error:
          `This session was submitted under Dealer ID ${session.dealer_code_used}, but the store ` +
          `now maps to ${dealerCode}. Documents must be retrieved under the Dealer ID that submitted them.`,
      });
    }

    // ── Step 2: The prefix and the buyer name, before TecAssured is asked ─
    const { data: provider } = await supabase
      .schema("fni")
      .from("providers")
      .select("name, document_prefix")
      .eq("id", store.providerId)
      .maybeSingle();
    const noPrefix = prefixProblem(provider as { name: string; document_prefix: string | null } | null);
    if (noPrefix) return json(409, { error: noPrefix });
    const prefix = String((provider as { document_prefix: string }).document_prefix);

    const deal = await dcDealFolders(session.zoho_deal_id ?? null, session.deal_number ?? null);
    const buyer = buyerNameFor(deal, session.buyer_display_name ?? null);
    if (!buyer) {
      return json(409, { error: "This deal has no buyer name, and its documents are named after the buyer. Refresh it from the CRM first." });
    }
    // Null until DocuRide DC has made the deal's folders.
    const folders = readyFolders(deal);

    // ── Step 3: The agreement and its contracts ──────────────────────────
    let agreementQuery = supabase.schema("fni").from("agreements").select("id, status").eq("session_id", session_id);
    agreementQuery = agreement_id
      ? agreementQuery.eq("id", agreement_id)
      : agreementQuery.order("created_at", { ascending: false }).limit(1);
    const { data: agreement, error: agreeErr } = await agreementQuery.single();
    if (agreeErr || !agreement) return json(400, { error: "No agreement found. Submit contracts first." });

    // Every contract on the deal, for the places; then the ones to fetch.
    const { data: allRows, error: prodErr } = await supabase
      .schema("fni")
      .from("agreement_products")
      .select("*")
      .eq("agreement_id", agreement.id);
    if (prodErr) return json(500, { error: `The contracts could not be read: ${prodErr.message}` });
    const rows = (allRows ?? []) as Record<string, unknown>[];
    const places = assignPositions(
      rows.map((r) => ({
        id: String(r.id),
        document_position: (r.document_position as number | null) ?? null,
        created_at: String(r.created_at ?? ""),
      }))
    );

    const products = rows.filter(
      (r) =>
        r.provider_id === store.providerId &&
        !r.recorded_by &&
        r.status !== "Voided" &&
        (!contract_number || r.contract_number === contract_number)
    );
    if (products.length === 0) {
      return json(400, {
        error: contract_number
          ? `Contract ${contract_number} is not a live ${store.providerName} contract on this deal.`
          : `This deal has no live ${store.providerName} contracts.`,
      });
    }

    const deps = liveMoveDeps(supabase);

    // ── Step 4: Each document ────────────────────────────────────────────
    const results: DocumentResult[] = [];

    for (const product of products) {
      const number = String(product.contract_number ?? "");
      const result: DocumentResult = {
        contract_number: number,
        provider_product_id: String(product.provider_product_id),
        file_name: null,
        document_status: (product.document_status as string | null) ?? null,
        workdrive_file_id: null,
        workdrive_url: null,
        page_count: null,
        error: null,
      };
      results.push(result);

      if (number === "") {
        result.error = "TecAssured gave this contract no number, so its document cannot be asked for.";
        continue;
      }

      try {
        const doc = (await client.getContractDocument(String(product.provider_product_id), number)) as Record<string, unknown>;
        if (doc.error && String(doc.error).trim() !== "") {
          result.error = `TecAssured did not return the document: ${String(doc.error)}`;
          continue;
        }

        // What TecAssured said, kept exactly as it said it.
        const record: Record<string, unknown> = {
          provider_signatures: doc.signatures ?? null,
          provider_document: withoutPdf(doc),
          document_retrieved_at: new Date().toISOString(),
        };

        const bytes = typeof doc.data === "string" ? fromBase64(doc.data) : null;
        if (!isPdf(bytes)) {
          await supabase.schema("fni").from("agreement_products").update(record).eq("id", product.id as string);
          result.error = "TecAssured's answer had no PDF in it, so nothing was held or saved.";
          continue;
        }
        const pages = pageSizes(await PDFDocument.load(bytes!, { ignoreEncryption: true }));
        record.page_count = pages.page_count;
        record.page_sizes = pages.page_sizes;
        result.page_count = pages.page_count;

        // ── Hold it in the bucket ──
        const position = places.get(String(product.id))!;
        const base = documentBaseName({
          prefix,
          position,
          deal_number: String(deal?.deal_number ?? session.deal_number ?? ""),
          buyer_display_name: buyer,
          product_name: String(product.product_name ?? ""),
          contract_number: number,
        });
        const path = `${session_id}/${storageFileName(base)}`;
        // The same contract's own earlier copy is replaced; nothing else is touched.
        const { error: holdErr } = await supabase.storage
          .from(HOLD_BUCKET)
          .upload(path, bytes!, { contentType: "application/pdf", upsert: true });
        if (holdErr) {
          await supabase.schema("fni").from("agreement_products").update(record).eq("id", product.id as string);
          result.error = "The document could not be held in DocuRide just now, so nothing was saved. Get it again.";
          console.error("fni-contract-documents: bucket save failed", { contract_number: number });
          continue;
        }
        record.document_position = position;
        record.document_storage_path = path;
        record.document_name = base;
        record.document_status = WAITING;
        // A fresh copy waits for, or replaces, its Deal Jacket file.
        record.workdrive_file_id = null;
        record.workdrive_saved_at = null;
        record.workdrive_file_name = null;

        const { error: updErr } = await supabase
          .schema("fni")
          .from("agreement_products")
          .update(record)
          .eq("id", product.id as string);
        if (updErr) {
          result.error = `The document is held, but its details could not be recorded (${updErr.code ?? "error"}). Get it again.`;
          continue;
        }
        result.document_status = WAITING;
        result.file_name = base;

        // ── And into the Deal Jacket, if it is there ──
        if (folders) {
          const [line] = await moveHeldDocuments(
            [
              {
                id: String(product.id),
                contract_number: number,
                document_name: base,
                document_storage_path: path,
                document_status: WAITING,
                workdrive_file_id: null,
              },
            ],
            folders,
            deps
          );
          result.file_name = line.file_name;
          if (line.moved) {
            const { data: saved } = await supabase
              .schema("fni")
              .from("agreement_products")
              .select("workdrive_file_id, document_status")
              .eq("id", product.id as string)
              .maybeSingle();
            const s = saved as { workdrive_file_id: string | null; document_status: string | null } | null;
            result.document_status = s?.document_status ?? result.document_status;
            result.workdrive_file_id = s?.workdrive_file_id ?? null;
            result.workdrive_url = s?.workdrive_file_id ? workDriveFileUrl(s.workdrive_file_id) : null;
          } else {
            result.error = `Held in DocuRide, but not saved to the Deal Jacket: ${line.outcome}`;
          }
        }
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      }
    }

    // ── Step 5: Finalized once every live contract's document is held ────
    const { data: after } = await supabase
      .schema("fni")
      .from("agreement_products")
      .select("status, recorded_by, document_storage_path, provider_id")
      .eq("agreement_id", agreement.id);
    const live = ((after ?? []) as Record<string, unknown>[]).filter(
      (r) => r.provider_id === store.providerId && !r.recorded_by && r.status !== "Voided"
    );
    const allHeld = live.length > 0 && live.every((r) => !!r.document_storage_path);
    if (allHeld) {
      await supabase
        .schema("fni")
        .from("agreements")
        .update({ status: "Finalized", finalized_at: new Date().toISOString() })
        .eq("id", agreement.id);
      await supabase.schema("fni").from("sessions").update({ status: "Finalized" }).eq("id", session_id);
    }

    return json(200, {
      session_id,
      agreement_id: agreement.id,
      status: allHeld ? "Finalized" : "Partial",
      deal_jacket: folders ? "Ready" : "Not made yet",
      documents: results,
      held_count: results.filter((r) => r.document_status !== null && r.error === null).length,
      saved_count: results.filter((r) => r.workdrive_file_id !== null).length,
      total_count: results.length,
      dealer_code: dealerCode,
      is_test: session.is_test === true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-contract-documents error:", message);
    return json(500, { error: message });
  }
});
