// fni-contract-documents/index.ts
//
// Retrieves contract PDFs from TecAssured after a successful contract/submit.
// Can fetch a single contract or all contracts for an agreement.
//
// Input (POST JSON):
//   session_id      - fni.sessions UUID (required)
//   agreement_id    - fni.agreements UUID (optional, defaults to latest)
//   contract_number - specific contract to fetch (optional, fetches all if omitted)
//
// Auth: FNI_WEBHOOK_SECRET via ?secret= query param or x-webhook-secret header
//
// Returns: array of { contract_number, pdf_base64, pdf_link, signature }
// Also updates fni.agreement_products with document_retrieved_at and updates
// fni.agreements status to "Finalized" when all docs are retrieved.
//
// ── Column fix, 2026-09-20 ───────────────────────────────────────────────
// This function read four columns that do not exist on fni.agreement_products,
// so it would have thrown the first time it ran with live credentials. Two were
// a rename against columns already on the table:
//
//     product.product_id      ->  product.provider_product_id
//     product.product_unique  ->  product.rate_unique_id
//
// The other two, document_retrieved_at and filename, had no counterpart in any
// form and are added by migration 0008, which lands with this file.
//
// It had only ever been deployed out of band; this is its first appearance in
// the repository.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  TecAssuredClient,
  TecAssuredCredentials,
} from "../_shared/tecassured.ts";
import { secretsMatch } from "../_shared/supabase.ts";

// ─── Types ───────────────────────────────────────────────────────────────

interface DocumentRequest {
  session_id: string;
  agreement_id?: string;
  contract_number?: string;
}

interface DocumentResult {
  contract_number: string;
  provider_product_id: string;
  pdf_base64: string | null;
  pdf_link: string | null;
  signature: unknown | null;
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

  // Auth
  const presented =
    url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
  const configured = Deno.env.get("FNI_WEBHOOK_SECRET");
  if (!secretsMatch(presented, configured)) {
    return json(401, { error: "Unauthorized" });
  }

  // Parse request
  let body: DocumentRequest;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { session_id, agreement_id, contract_number } = body;
  if (!session_id) {
    return json(400, { error: "session_id is required" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // ── Step 1: Load session ───────────────────────────────────────────
    const { data: session, error: sessErr } = await supabase
      .schema("fni")
      .from("sessions")
      .select("credential_id")
      .eq("id", session_id)
      .single();

    if (sessErr || !session) {
      return json(404, { error: `Session ${session_id} not found` });
    }

    if (!session.credential_id) {
      return json(400, { error: "No credentials for this session" });
    }

    // ── Step 2: Load credentials ───────────────────────────────────────
    const { data: cred, error: credErr } = await supabase
      .schema("fni")
      .from("provider_credentials")
      .select("*")
      .eq("id", session.credential_id)
      .single();

    if (credErr || !cred) {
      return json(400, { error: "TecAssured credentials not found" });
    }

    const credentials = cred as TecAssuredCredentials;

    if (!credentials.dealer_code) {
      return json(400, { error: "Dealer code not configured" });
    }

    // ── Step 3: Find the agreement and its products ────────────────────
    let agreementQuery = supabase
      .schema("fni")
      .from("agreements")
      .select("id, status")
      .eq("session_id", session_id);

    if (agreement_id) {
      agreementQuery = agreementQuery.eq("id", agreement_id);
    } else {
      agreementQuery = agreementQuery
        .order("created_at", { ascending: false })
        .limit(1);
    }

    const { data: agreement, error: agreeErr } = await agreementQuery.single();

    if (agreeErr || !agreement) {
      return json(400, {
        error: "No agreement found. Submit contracts first.",
      });
    }

    // Load agreement products
    let productsQuery = supabase
      .schema("fni")
      .from("agreement_products")
      .select("*")
      .eq("agreement_id", agreement.id);

    if (contract_number) {
      productsQuery = productsQuery.eq("contract_number", contract_number);
    }

    const { data: products, error: prodErr } = await productsQuery;

    if (prodErr || !products || products.length === 0) {
      return json(400, {
        error: contract_number
          ? `Contract ${contract_number} not found in this agreement`
          : "No contract products found in this agreement",
      });
    }

    // ── Step 4: Fetch documents from TecAssured ────────────────────────
    const client = new TecAssuredClient(credentials, supabase);
    const results: DocumentResult[] = [];
    const signatureMapLines: string[] = [];

    for (const product of products) {
      try {
        const docResponse = await client.getContractDocument(
          credentials.dealer_code!,
          product.provider_product_id,
          product.contract_number
        );

        const doc = docResponse as Record<string, unknown>;

        if (doc.error && String(doc.error).trim() !== "") {
          results.push({
            contract_number: product.contract_number,
            provider_product_id: product.provider_product_id,
            pdf_base64: null,
            pdf_link: null,
            signature: null,
            error: String(doc.error),
          });
          continue;
        }

        // Build the filename: FNI_{rate unique}_{contractNumber}.pdf
        //
        // The filename is the first field of this contract's FNI_Signature_Map
        // line, and that field is a Zoho textarea capped at 2000 characters, so
        // a longer identifier here spends more of that budget per contract.
        // Still comfortably within it for any realistic number of contracts.
        const ptype = product.rate_unique_id ?? "DOC";
        const filename = `FNI_${ptype}_${product.contract_number}.pdf`;

        // Build signature map line if coordinates are present
        const sig = doc.signature as Record<string, unknown> | null;
        if (sig && sig.page !== undefined) {
          const line = [
            filename,
            sig.page,
            sig.left,
            sig.top,
            sig.right,
            sig.bottom,
            sig.type ?? "buyer",
          ].join("|");
          signatureMapLines.push(line);
        }

        results.push({
          contract_number: product.contract_number,
          provider_product_id: product.provider_product_id,
          pdf_base64: (doc.data as string) ?? null,
          pdf_link: (doc.pdfLink as string) ?? null,
          signature: sig ?? null,
          error: null,
        });

        // Update the agreement product with retrieval timestamp. Both columns
        // are added by migration 0008; before it they did not exist and this
        // UPDATE would have errored.
        await supabase
          .schema("fni")
          .from("agreement_products")
          .update({
            document_retrieved_at: new Date().toISOString(),
            filename: filename,
          })
          .eq("id", product.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          contract_number: product.contract_number,
          provider_product_id: product.provider_product_id,
          pdf_base64: null,
          pdf_link: null,
          signature: null,
          error: message,
        });
      }
    }

    // ── Step 5: Update agreement status if all docs retrieved ───────────
    const allRetrieved = results.every(
      (r) => r.pdf_base64 !== null || r.pdf_link !== null
    );

    if (allRetrieved && results.length > 0) {
      await supabase
        .schema("fni")
        .from("agreements")
        .update({ status: "Finalized", finalized_at: new Date().toISOString() })
        .eq("id", agreement.id);

      await supabase
        .schema("fni")
        .from("sessions")
        .update({ status: "Finalized" })
        .eq("id", session_id);
    }

    // ── Step 6: Return results ─────────────────────────────────────────
    return json(200, {
      session_id: session_id,
      agreement_id: agreement.id,
      status: allRetrieved ? "Finalized" : "Partial",
      documents: results,
      // Pre-built signature map for Zoho CRM field write-back.
      // One line per contract: filename|page|left|top|right|bottom|signer_type
      // The Deluge function in Flow parses this to place signature fields.
      signature_map: signatureMapLines.join("\n"),
      retrieved_count: results.filter((r) => r.error === null).length,
      total_count: results.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-contract-documents error:", message);
    return json(500, { error: message });
  }
});
