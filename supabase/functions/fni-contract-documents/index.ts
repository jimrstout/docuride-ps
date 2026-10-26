// fni-contract-documents/index.ts
//
// Pulls each contract's document from TecAssured and saves it to the deal's
// WorkDrive Deal Jacket, named so it sits alongside DocuRide DC's own
// documents. See docs/multi-provider.md, section 12.
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
//   • The provider has a document prefix (Admin > Providers). Without one its
//     documents cannot be sent to WorkDrive, and this says so.
//   • The deal is in DocuRide DC (dc.deals, by Zoho id, then deal number)
//     with a Deal Jacket and a Signed Documents folder. Otherwise "Missing
//     Folder", as DC says, and nothing is saved. Folders are made only by
//     DocuRide DC (V2 Generate Documents); nothing here makes one.
//
// ── For each contract ────────────────────────────────────────────────────
//   1. Ask TecAssured for the document.
//   2. Keep exactly what it said: the signature data as returned (every
//      field, nothing converted) and everything else it returned except the
//      PDF itself. Count the PDF's pages and measure each in points.
//   3. Name it (_shared/document-names.ts):
//        TA01 MUI #13759 {buyer} {product} {contract}|SignedDocuRideDC|{signed folder id}|.pdf
//   4. Replace, don't duplicate: a file in the Deal Jacket with that name is
//      moved to the WorkDrive trash first, as DocuRide DC replaces its own;
//      then the PDF is uploaded.
//   5. Record the WorkDrive file id, name and when it was saved.
// Voided contracts and OEM contracts recorded by staff are left alone.
//
// WorkDrive is reached with DocuRide DC's Zoho client and its shared token
// (_shared/dc-zoho.ts). No token or secret value is read, logged or returned,
// and nothing logs a buyer's name or a file name.
//
// Returns: { documents: [{ contract_number, file_name, workdrive_file_id,
// workdrive_url, page_count, error }], status, saved_count, total_count }.
// The PDF itself is not returned: it is in the Deal Jacket.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { createTecAssuredClient } from "../_shared/tecassured.ts";
import { secretsMatch } from "../_shared/supabase.ts";
import { contractCallRefusal } from "../_shared/contract-guard.ts";
import { assignPositions, folderProblem, MISSING_FOLDER, prefixProblem, type DealFolders } from "../_shared/contract-documents.ts";
import { contractFileName, sameDocument } from "../_shared/document-names.ts";
import { fromBase64, isPdf, pageSizes, withoutPdf } from "../_shared/pdf-pages.ts";
import { dcDb } from "../_shared/dc-zoho.ts";
import { listFolderItems, trashFile, uploadPdf, workDriveFileUrl, workDriveProblem } from "../_shared/workdrive.ts";

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

/** The deal in DocuRide DC: by Zoho id first, then by deal number. */
async function dcDeal(zohoId: string | null, dealNumber: string | null): Promise<DealFolders | null> {
  const sql = dcDb();
  const cols = sql`deal_number, buyer_display_name, deal_jacket_folder_id, signed_documents_folder_id`;
  if (zohoId) {
    const rows = await sql`select ${cols} from dc.deals where zoho_id = ${zohoId} limit 1`;
    if (rows[0]) return rows[0] as unknown as DealFolders;
  }
  if (dealNumber) {
    const rows = await sql`select ${cols} from dc.deals where deal_number = ${dealNumber} order by updated_at desc limit 2`;
    // Two DC deals with one number is not a guess to make with somebody's paperwork.
    if (rows.length === 1) return rows[0] as unknown as DealFolders;
  }
  return null;
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
      .select("id, store_id, is_test, dealer_code_used, deal_number, zoho_deal_id")
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

    // ── Step 2: The prefix and the folders, before TecAssured is asked ───
    const { data: provider } = await supabase
      .schema("fni")
      .from("providers")
      .select("name, document_prefix")
      .eq("id", store.providerId)
      .maybeSingle();
    const noPrefix = prefixProblem(provider as { name: string; document_prefix: string | null } | null);
    if (noPrefix) return json(409, { error: noPrefix });
    const prefix = String((provider as { document_prefix: string }).document_prefix);

    const deal = await dcDeal(session.zoho_deal_id ?? null, session.deal_number ?? null);
    const noFolder = folderProblem(deal);
    if (noFolder) return json(409, { error: `${MISSING_FOLDER}. ${noFolder}`, reason: MISSING_FOLDER });
    const folders = deal!;

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

    // ── Step 4: Each document ────────────────────────────────────────────
    let folderItems: { id: string; name: string }[] | null = null;
    const results: DocumentResult[] = [];

    for (const product of products) {
      const number = String(product.contract_number ?? "");
      const result: DocumentResult = {
        contract_number: number,
        provider_product_id: String(product.provider_product_id),
        file_name: null,
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
          result.error = "TecAssured's answer had no PDF in it, so nothing was saved to WorkDrive.";
          continue;
        }
        const pages = pageSizes(await PDFDocument.load(bytes!, { ignoreEncryption: true }));
        record.page_count = pages.page_count;
        record.page_sizes = pages.page_sizes;
        result.page_count = pages.page_count;

        const position = places.get(String(product.id))!;
        const name = contractFileName({
          prefix,
          position,
          deal_number: String(folders.deal_number ?? session.deal_number ?? ""),
          buyer_display_name: String(folders.buyer_display_name ?? ""),
          product_name: String(product.product_name ?? ""),
          contract_number: number,
          signed_documents_folder_id: String(folders.signed_documents_folder_id),
        });
        result.file_name = name;
        record.document_position = position;
        record.filename = name;

        try {
          // Replace, don't duplicate.
          folderItems ??= await listFolderItems(String(folders.deal_jacket_folder_id));
          for (const f of folderItems.filter((f) => sameDocument(f.name, name))) await trashFile(f.id);
          const fileId = await uploadPdf(String(folders.deal_jacket_folder_id), name, bytes!);
          folderItems = folderItems.filter((f) => !sameDocument(f.name, name)).concat([{ id: fileId, name }]);

          record.workdrive_file_id = fileId;
          record.workdrive_file_name = name;
          record.workdrive_saved_at = new Date().toISOString();
          result.workdrive_file_id = fileId;
          result.workdrive_url = workDriveFileUrl(fileId);
        } catch (err) {
          result.error = workDriveProblem(err);
          console.error("fni-contract-documents: WorkDrive save failed", {
            contract_number: number,
            status: (err as { status?: unknown })?.status ?? null,
            code: (err as { code?: unknown })?.code ?? null,
          });
        }

        const { error: updErr } = await supabase
          .schema("fni")
          .from("agreement_products")
          .update(record)
          .eq("id", product.id as string);
        if (updErr) {
          result.error =
            (result.error ? `${result.error} ` : "") +
            `The document's details could not be recorded (${updErr.code ?? "error"}). Get it again.`;
        }
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      }
    }

    // ── Step 5: Finalized once every live contract's document is saved ───
    const { data: after } = await supabase
      .schema("fni")
      .from("agreement_products")
      .select("status, recorded_by, workdrive_file_id, provider_id")
      .eq("agreement_id", agreement.id);
    const live = ((after ?? []) as Record<string, unknown>[]).filter(
      (r) => r.provider_id === store.providerId && !r.recorded_by && r.status !== "Voided"
    );
    const allSaved = live.length > 0 && live.every((r) => !!r.workdrive_file_id);
    if (allSaved) {
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
      status: allSaved ? "Finalized" : "Partial",
      documents: results,
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
