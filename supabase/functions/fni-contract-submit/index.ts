// fni-contract-submit/index.ts
// Submits the customer's selections to TecAssured to generate contracts.
//
// Input (POST JSON):
//   session_id  - fni.sessions UUID (required)
//   selections  - [{ product_unique, rate_unique, option_uniques[], retail_price }]
//
// Auth: FNI_WEBHOOK_SECRET via ?secret= query param or x-webhook-secret header
//
// ── One login, many dealers (2026-09-25) ────────────────────────────────
// The dealer code now comes from the store's mapping rather than the credential
// row, and the code actually used is recorded on the session. See
// fni-rate-vehicle for why that is a copy and not a join.
//
// ── The persistence layer was writing to columns that do not exist ──────
// Found while making the dealer-code change, and fixed here because the change
// could not be tested end to end otherwise. As deployed, this function could
// never have completed a submit against the current schema:
//
//   agreements        provider, provider_agreement_id, submitted_at,
//                     request_payload and response_payload were all inserted
//                     and none of them are columns. The real columns are
//                     tecassured_sale_id and sale_format.
//   agreements.status "Submitted" is not in the CHECK (Draft|Finalized|Voided).
//   agreement_products product_unique, rate_unique, product_id, retail_price
//                     and sort_order were inserted and none exist, while seven
//                     NOT NULL columns went unwritten -- including
//                     selected_product_id, which is a foreign key.
//   selected_products  the same three invented columns again.
//   sessions.status   "Submitted" is not in that CHECK either; the value for
//                     this point in the flow is "Agreement Created".
//   allowedStatuses   gated on "Presented", which is not a status. The real
//                     one is "Presenting".
//
// So this rewrites the whole persistence half against the actual tables. The
// TecAssured request building is unchanged apart from the dealer code.
//
// ── It also read product keys that do not exist (2026-09-25) ───────────
// Against a real quote the product node carries `label`, `ptype` and `unique`,
// not name/productName, productType/type or productId/id. So this recorded
// product_name as the unique ("754_6") and product_type as "Unknown" for every
// contract, and only got provider_product_id right by falling through to
// `unique`. That reading now lives in _shared/offer-selections.ts, where the
// real 78KB quote in test/fixtures/ is run against it.
//
// ── Dealer cost is validated BEFORE the call, not after ─────────────────
// agreement_products.final_dealer_cost is NOT NULL, and a contract whose cost
// we cannot state is a contract we cannot record. Checking after submitting
// would leave real contracts alive at TecAssured with no row here, so the check
// happens first and refuses to submit at all.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createTecAssuredClient } from "../_shared/tecassured.ts";
import { secretsMatch } from "../_shared/supabase.ts";
import {
  applySelections,
  deepClone,
  str,
  type ProductSelection,
} from "../_shared/offer-selections.ts";

// ─── Types ───────────────────────────────────────────────────────────────

interface ContractSubmitRequest {
  session_id: string;
  selections: ProductSelection[];
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

  const presented =
    url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
  if (!secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }

  let body: ContractSubmitRequest;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { session_id, selections } = body;
  if (!session_id) return json(400, { error: "session_id is required" });
  if (!Array.isArray(selections) || selections.length === 0) {
    return json(400, { error: "At least one product selection is required" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // ── Step 1: Load the session ───────────────────────────────────────
    const { data: session, error: sessErr } = await supabase
      .schema("fni")
      .from("sessions")
      .select("*")
      .eq("id", session_id)
      .single();

    if (sessErr || !session) return json(404, { error: `Session ${session_id} not found` });

    // The real vocabulary, from the CHECK on fni.sessions.status.
    const allowed = ["Rated", "Presenting", "Products Selected"];
    if (!allowed.includes(session.status)) {
      return json(400, {
        error: `Session is ${session.status}. Must be one of ${allowed.join(", ")} to submit contracts.`,
      });
    }

    // ── Step 2: Load the rated offer ───────────────────────────────────
    const { data: ratedOffer, error: offerErr } = await supabase
      .schema("fni")
      .from("rated_offers")
      .select("*")
      .eq("session_id", session_id)
      .single();

    if (offerErr || !ratedOffer) {
      return json(400, { error: "No rated offer found for this session. Rate the vehicle first." });
    }

    // ── Step 3: Which login, which Dealer ID ───────────────────────────
    let store;
    try {
      store = await createTecAssuredClient(session.store_id, supabase);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
    const { client, credentials, dealerCode } = store;

    // ── Step 4: Flag the selections and read back what they cost ───────
    const offerClone = deepClone(ratedOffer.response_payload) as Record<string, unknown>;
    const resolved = applySelections(offerClone, selections);

    // Every selection must have been found in the offer. One that was not is a
    // stale menu, and submitting the rest silently would sell a different set
    // of products than the customer agreed to.
    const foundRates = new Set(resolved.map((r) => r.selection.rate_unique));
    const notFound = selections.filter((s) => !foundRates.has(s.rate_unique));
    if (notFound.length > 0) {
      return json(400, {
        error: "Some selections were not found in the rated offer. Re-rate and present again.",
        missing: notFound.map((s) => ({ product_unique: s.product_unique, rate_unique: s.rate_unique })),
      });
    }

    // And every one must have a dealer cost, because the row that records the
    // contract cannot be written without it. Checked here, before anything is
    // submitted, so a failure leaves nothing behind at TecAssured.
    const uncosted = resolved.filter((r) => r.dealerCost === null);
    if (uncosted.length > 0) {
      return json(400, {
        error:
          "The rated offer carries no dealer cost for some selected rates, so the " +
          "contract could not be recorded accurately. Re-rate before submitting.",
        uncosted: uncosted.map((r) => ({
          product_unique: r.selection.product_unique,
          rate_unique: r.rateUniqueId,
          product_name: r.productName,
        })),
      });
    }

    // ── Step 5: Buyer and lienholder ───────────────────────────────────
    if (session.buyer_first_name) offerClone.buyerFirstName = session.buyer_first_name;
    if (session.buyer_last_name) offerClone.buyerLastName = session.buyer_last_name;
    if (session.buyer_address) offerClone.buyerAddress = session.buyer_address;

    const lienholder: Record<string, string> = {};
    if (session.lienholder_name) lienholder.lienholderName = session.lienholder_name;
    if (session.lienholder_address) lienholder.lienholderAddress = session.lienholder_address;
    if (session.lienholder_city) lienholder.lienholderCity = session.lienholder_city;
    if (session.lienholder_state) lienholder.lienholderState = session.lienholder_state;
    if (session.lienholder_zip) lienholder.lienholderZip = session.lienholder_zip;
    if (session.lienholder_phone) lienholder.lienholderPhone = session.lienholder_phone;

    const submitPayload: Record<string, unknown> = { quote: offerClone };
    if (Object.keys(lienholder).length > 0) submitPayload.lienholder = lienholder;

    // ── Step 6: Submit ─────────────────────────────────────────────────
    const submitResponse = await client.submitContract(submitPayload);
    const response = (submitResponse ?? {}) as Record<string, unknown>;

    if (response.error && String(response.error).trim() !== "") {
      return json(400, {
        error: `TecAssured contract submit failed: ${response.error}`,
        tecassured_error: response.error,
      });
    }

    const contracts = (Array.isArray(response.contracts) ? response.contracts : []) as Record<string, unknown>[];

    // ── Step 7: The agreement ──────────────────────────────────────────
    // Upsert on session_id, which carries a UNIQUE constraint: one agreement
    // per session, so a retried submit updates rather than colliding.
    const { data: agreement, error: agreementErr } = await supabase
      .schema("fni")
      .from("agreements")
      .upsert(
        {
          session_id,
          // Draft until the documents come back. "Finalized" is
          // fni-contract-documents' word to say, once the PDFs exist.
          status: "Draft",
          tecassured_sale_id: str(response.saleId ?? response.saleID ?? response.id, "") || null,
          sale_format: submitResponse,
        },
        { onConflict: "session_id" }
      )
      .select("id")
      .single();

    if (agreementErr || !agreement) {
      // Contracts may now exist at TecAssured with nothing here pointing at
      // them. Say so plainly: this needs a person, not a retry.
      console.error(`Failed to store agreement: ${agreementErr?.message}`);
      return json(500, {
        error:
          "Contracts were submitted to TecAssured but the agreement could not be recorded. " +
          "Do not retry; the contracts may already exist.",
        detail: agreementErr?.message,
        tecassured_response: submitResponse,
      });
    }

    // ── Step 8: The customer's choices ─────────────────────────────────
    // Upserted on (session_id, provider_product_id), the same key the planner's
    // autosave uses, so a product the customer already decided on is updated
    // rather than duplicated.
    const now = new Date().toISOString();
    const selectedRows = resolved.map((r) => ({
      session_id,
      provider_product_id: r.providerProductId,
      product_type: r.productType,
      product_name: r.productName,
      disposition: "Included",
      rate_unique_id: r.rateUniqueId,
      term_months: r.termMonths,
      term_miles: r.termMiles,
      deductible: r.deductible,
      dealer_cost: r.dealerCost,
      retail_price: r.selection.retail_price,
      customer_price: r.selection.retail_price,
      selected_options: r.selection.option_uniques ?? [],
      rate_snapshot: r.rateSnapshot,
      selected_at: now,
    }));

    const { data: selectedSaved, error: selErr } = await supabase
      .schema("fni")
      .from("selected_products")
      .upsert(selectedRows, { onConflict: "session_id,provider_product_id" })
      .select("id, provider_product_id");

    if (selErr || !selectedSaved) {
      console.error(`Failed to store selected products: ${selErr?.message}`);
      return json(500, {
        error:
          "Contracts were submitted to TecAssured but the selections could not be recorded. " +
          "Do not retry; the contracts may already exist.",
        detail: selErr?.message,
        agreement_id: agreement.id,
      });
    }

    const selectedIdByProduct = new Map(
      (selectedSaved as { id: string; provider_product_id: string }[]).map(
        (row) => [row.provider_product_id, row.id]
      )
    );

    // ── Step 9: The contracts themselves ───────────────────────────────
    // Matched to selections by rate unique id, which is what TecAssured echoes
    // back. A contract we cannot match is still recorded rather than dropped.
    const byRate = new Map(resolved.map((r) => [r.rateUniqueId, r]));

    const productRows: Record<string, unknown>[] = [];
    const unmatched: unknown[] = [];

    for (const c of contracts) {
      const rateId = str(c.rateUniqueId ?? c.rateUnique, "");
      const r = byRate.get(rateId);

      if (!r) {
        unmatched.push({ contract_number: c.contractNumber, rate_unique_id: rateId });
        continue;
      }

      const selectedProductId = selectedIdByProduct.get(r.providerProductId);
      if (!selectedProductId) {
        unmatched.push({ contract_number: c.contractNumber, rate_unique_id: rateId });
        continue;
      }

      productRows.push({
        agreement_id: agreement.id,
        selected_product_id: selectedProductId,
        product_type: r.productType,
        product_name: r.productName,
        // TecAssured's own product id from the response when it sends one:
        // the document and void endpoints are keyed on it.
        provider_product_id: str(c.productId, r.providerProductId),
        rate_unique_id: r.rateUniqueId,
        term_months: r.termMonths,
        term_miles: r.termMiles,
        deductible: r.deductible,
        final_dealer_cost: (r.dealerCost ?? 0) + r.optionCostTotal,
        final_customer_price: r.selection.retail_price,
        selected_options: r.selection.option_uniques ?? [],
        contract_number: str(c.contractNumber, "") || null,
        pdf_link: str(c.pdfLink, "") || null,
      });
    }

    if (productRows.length > 0) {
      const { error: prodErr } = await supabase
        .schema("fni")
        .from("agreement_products")
        .insert(productRows);

      if (prodErr) {
        console.error(`Failed to store agreement products: ${prodErr.message}`);
        return json(500, {
          error:
            "Contracts were submitted to TecAssured but could not be recorded. " +
            "Do not retry; the contracts may already exist.",
          detail: prodErr.message,
          agreement_id: agreement.id,
          contracts: contracts.map((c) => c.contractNumber),
        });
      }
    }

    // ── Step 10: Advance the session ───────────────────────────────────
    const { error: statusErr } = await supabase
      .schema("fni")
      .from("sessions")
      .update({
        status: "Agreement Created",
        credential_id: credentials.id,
        dealer_code_used: dealerCode,
      })
      .eq("id", session_id);

    if (statusErr) console.error(`Failed to update session status: ${statusErr.message}`);

    return json(200, {
      session_id,
      status: "Agreement Created",
      agreement_id: agreement.id,
      dealer_code: dealerCode,
      environment: credentials.environment,
      is_test: session.is_test === true,
      contracts: productRows.map((p) => ({
        contract_number: p.contract_number,
        provider_product_id: p.provider_product_id,
        product_name: p.product_name,
        rate_unique_id: p.rate_unique_id,
        pdf_link: p.pdf_link,
      })),
      contract_count: productRows.length,
      // Present only when TecAssured returned a contract we could not tie back
      // to a selection. Never silently dropped.
      unmatched_contracts: unmatched.length > 0 ? unmatched : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-contract-submit error:", message);
    return json(500, { error: message });
  }
});
