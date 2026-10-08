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
import { offerRowsFor, tecAssuredRow } from "../_shared/provider-rows.ts";
import {
  buildSubmitQuote,
  str,
  type ProductSelection,
} from "../_shared/offer-selections.ts";
import {
  blockingByProduct,
  describeContract,
  submitRefusal,
  type ContractRef,
  type SubmitLockState,
} from "../_shared/duplicates.ts";

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

  // The lock's state lives out here, above the try, because the catch is the
  // one place that has to decide what to leave it as. Everything from the
  // moment it is taken must leave it in a defensible state: Idle if TecAssured
  // was never called, Submit Status Unknown if it was and we got no answer.
  let lockToken: string | null = null;
  let lockHeld = false;
  let providerWasCalled = false;

  /** Put the session back to Idle. Used on every path that did not reach the
   *  provider, and on the ones that reached it and got a clear answer. */
  const releaseLock = async () => {
    lockHeld = false;
    await supabase
      .schema("fni")
      .from("sessions")
      .update({
        submit_state: "Idle",
        submit_started_at: null,
        submit_token: null,
        submit_detail: null,
      })
      .eq("id", session_id)
      .eq("submit_token", lockToken);
  };

  /**
   * Leave the lock saying nobody knows.
   *
   * Never released on a timer. A submit that reached the provider and went
   * quiet may well have created paperwork, and releasing the lock would be
   * guessing that it did not -- which is exactly the guess that produces two
   * live contracts for one product.
   */
  const markUnknown = async (detail: string) => {
    lockHeld = false;
    await supabase
      .schema("fni")
      .from("sessions")
      .update({
        submit_state: "Submit Status Unknown",
        submit_detail: detail,
      })
      .eq("id", session_id)
      .eq("submit_token", lockToken);
  };

  /** Refuse, and hand the lock back, because nothing was sent. */
  const refuse = async (status: number, body: Record<string, unknown>) => {
    await releaseLock();
    return json(status, body);
  };

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
    //
    // Agreement Created is in this list now, and that is the point. It was the
    // only thing standing between a double-click and a second real contract, and
    // it was the wrong thing: blunt (a session with one contract could not add a
    // second product at all), leaky (the status update that produces it is
    // logged rather than fatal, so a failure left the session submittable), and
    // silent about what already existed. The lock below and the per-product
    // check after it are the guards now, and they say what they found.
    const allowed = ["Rated", "Presenting", "Products Selected", "Agreement Created"];
    if (!allowed.includes(session.status)) {
      return json(400, {
        error: `Session is ${session.status}. Must be one of ${allowed.join(", ")} to submit contracts.`,
      });
    }

    // ── Step 1b: One submit at a time ──────────────────────────────────
    //
    // A double-click, an impatient retry and a second browser tab all arrive as
    // concurrent requests that each pass every read-only check before either
    // writes anything. So the lock is taken with a conditional UPDATE, which
    // Postgres applies atomically: of two requests, exactly one gets a row back.
    const refusal = submitRefusal(session as unknown as SubmitLockState);
    if (refusal) {
      return json(409, {
        error: refusal,
        submit_state: session.submit_state,
        submit_started_at: session.submit_started_at ?? null,
      });
    }

    lockToken = crypto.randomUUID();
    const { data: locked } = await supabase
      .schema("fni")
      .from("sessions")
      .update({
        submit_state: "In Progress",
        submit_started_at: new Date().toISOString(),
        submit_token: lockToken,
        submit_detail: null,
      })
      .eq("id", session_id)
      // The whole guard. Only a session nobody is submitting can be locked, and
      // the loser of a race gets no row rather than a second provider call.
      .eq("submit_state", "Idle")
      .select("id")
      .maybeSingle();

    if (!locked) {
      lockToken = null;
      return json(409, {
        error:
          "Another submit for this session started first. Wait for it to finish, " +
          "then reload to see the result.",
        submit_state: "In Progress",
      });
    }

    lockHeld = true;

    // ── Step 2: Load the rated offer ───────────────────────────────────
    // The TecAssured provider's attempt: this is the Through API submit, and
    // TecAssured is the provider it goes to.
    const ratedOffer = tecAssuredRow(await offerRowsFor(supabase, session_id));

    if (!ratedOffer) {
      return await refuse(400, { error: "No rated offer found for this session. Rate the vehicle first." });
    }

    // ── Step 3: Which login, which Dealer ID ───────────────────────────
    let store;
    try {
      store = await createTecAssuredClient(session.store_id, supabase);
    } catch (err) {
      return await refuse(400, { error: err instanceof Error ? err.message : String(err) });
    }
    const { client, credentials, dealerCode } = store;

    // ── Step 4: Cut the quote down to what is being bought ────────────
    // Pruned, not flagged: see _shared/offer-selections.ts. Sending all
    // eleven products with flags is a request to submit all eleven, and the
    // QA server simply stopped responding when we did.
    const offerPayload = ratedOffer.response_payload as Record<string, unknown>;
    const { resolved } = buildSubmitQuote(offerPayload, selections);

    // Every selection must have been found in the offer. One that was not is a
    // stale menu, and submitting the rest silently would sell a different set
    // of products than the customer agreed to.
    const foundRates = new Set(resolved.map((r) => r.selection.rate_unique));
    const notFound = selections.filter((s) => !foundRates.has(s.rate_unique));
    if (notFound.length > 0) {
      return await refuse(400, {
        error: "Some selections were not found in the rated offer. Re-rate and present again.",
        missing: notFound.map((s) => ({ product_unique: s.product_unique, rate_unique: s.rate_unique })),
      });
    }

    // And every one must have a dealer cost, because the row that records the
    // contract cannot be written without it. Checked here, before anything is
    // submitted, so a failure leaves nothing behind at TecAssured.
    const uncosted = resolved.filter((r) => r.dealerCost === null);
    if (uncosted.length > 0) {
      return await refuse(400, {
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

    // And none may be priced above what the provider will allow. It rejects
    // the whole submit otherwise, naming the cap, so the check belongs here
    // where it can name the product instead.
    const overCap = resolved.filter((r) => r.overCap);
    if (overCap.length > 0) {
      return await refuse(400, {
        error:
          "Some selections are priced above what the provider will sell them for, " +
          "so the submit would be refused in full.",
        over_cap: overCap.map((r) => ({
          product_name: r.productName,
          rate_unique: r.rateUniqueId,
          retail_price: r.selection.retail_price,
          maximum_selling_price: r.offeredPrice,
          dealer_cost: r.dealerCost,
          provider_markup: r.providerMarkup,
          option_cost: r.optionCostTotal,
        })),
      });
    }

    // ── Step 4b: A product that already has paperwork ──────────────────
    //
    // Jim's rule, and the one the schema now also enforces: there is never more
    // than one live contract for the same product on the same deal.
    //
    // A selection whose product already has one is not an error to shout about
    // and not a thing to submit again. The existing contract number is handed
    // straight back, because that IS the answer to "submit this product": it is
    // already done, and here is the paperwork. A retry after a dropped response
    // therefore looks like a success to whoever retried, which is what makes the
    // endpoint safe to retry at all.
    //
    // A customer who has genuinely changed their mind is a different matter, and
    // it needs a person: the old contract must be voided at TecAssured first.
    // That is said in words rather than done automatically, because voiding
    // somebody's contract is not a side effect.
    const { data: existingAgreement } = await supabase
      .schema("fni")
      .from("agreements")
      .select("id")
      .eq("session_id", session_id)
      .maybeSingle();

    let alreadyContracted = new Map<string, ContractRef>();

    if (existingAgreement) {
      const { data: existingRows } = await supabase
        .schema("fni")
        .from("agreement_products")
        .select("provider_product_id, contract_number, product_name, status, rate_unique_id, pdf_link")
        .eq("agreement_id", (existingAgreement as { id: string }).id);

      alreadyContracted = blockingByProduct(
        (existingRows ?? []) as unknown as ContractRef[]
      );
    }

    // Same product, same rate: already done. Same product, different rate: the
    // customer changed their mind and somebody has to void the old one.
    const already: ContractRef[] = [];
    const changedMind: { contract: ContractRef; wanted: string }[] = [];

    for (const r of resolved) {
      const existing = alreadyContracted.get(r.providerProductId);
      if (!existing) continue;

      const sameRate =
        (existing as unknown as { rate_unique_id?: string }).rate_unique_id === r.rateUniqueId;

      if (sameRate) already.push(existing);
      else changedMind.push({ contract: existing, wanted: r.rateUniqueId });
    }

    if (changedMind.length > 0) {
      return await refuse(409, {
        error:
          "This deal already has a live contract for " +
          changedMind.map((c) => describeContract(c.contract)).join(", ") +
          ", on a different rate than the one selected. Void it in TecAssured " +
          "first, then submit again. There must never be two live contracts for " +
          "the same product on one deal.",
        must_void_first: changedMind.map((c) => ({
          product_name: c.contract.product_name,
          provider_product_id: c.contract.provider_product_id,
          contract_number: c.contract.contract_number,
          status: c.contract.status,
          selected_rate_unique_id: c.wanted,
        })),
      });
    }

    // Every selection is already contracted, on the rate asked for. Nothing to
    // send. Answered 200 with the numbers, because from the caller's point of
    // view the request succeeded: these products have contracts.
    const toSubmit = resolved.filter((r) => !alreadyContracted.has(r.providerProductId));

    if (toSubmit.length === 0) {
      await releaseLock();
      return json(200, {
        session_id,
        status: session.status,
        already_submitted: true,
        contracts: already.map((c) => ({
          contract_number: c.contract_number,
          provider_product_id: c.provider_product_id,
          product_name: c.product_name,
          status: c.status,
        })),
        contract_count: already.length,
        message:
          already.length === 1
            ? `Already submitted: ${describeContract(already[0])}. No new contract was created.`
            : `Already submitted: ${already.map(describeContract).join(", ")}. ` +
              `No new contracts were created.`,
      });
    }

    // ── Step 4c: The quote, pruned to what is actually being sent ──────
    //
    // Rebuilt from only the selections without a contract. Presence is the
    // selector on /contract/submit -- section 7, and the reason a flagged quote
    // of all eleven products hung the QA server -- so leaving an
    // already-contracted product in the quote would ask for a second contract
    // for it. The one case that matters is a partial retry: two products
    // selected, one already done, and this is what keeps the second submit to
    // the one that is missing.
    const { quote: submitQuote } = buildSubmitQuote(
      offerPayload,
      toSubmit.map((r) => r.selection)
    );

    // ── Step 5: Buyer and lienholder ───────────────────────────────────
    if (session.buyer_first_name) submitQuote.buyerFirstName = session.buyer_first_name;
    if (session.buyer_last_name) submitQuote.buyerLastName = session.buyer_last_name;
    if (session.buyer_address) submitQuote.buyerAddress = session.buyer_address;

    const lienholder: Record<string, string> = {};
    if (session.lienholder_name) lienholder.lienholderName = session.lienholder_name;
    if (session.lienholder_address) lienholder.lienholderAddress = session.lienholder_address;
    if (session.lienholder_city) lienholder.lienholderCity = session.lienholder_city;
    if (session.lienholder_state) lienholder.lienholderState = session.lienholder_state;
    if (session.lienholder_zip) lienholder.lienholderZip = session.lienholder_zip;
    if (session.lienholder_phone) lienholder.lienholderPhone = session.lienholder_phone;

    // dealerCode is required at the top level and is NOT inferred from the
    // session. Without it the server answers {"error":"Missing Dealer Code."},
    // which is how this was found.
    const submitPayload: Record<string, unknown> = {
      dealerCode,
      quote: submitQuote,
    };
    if (Object.keys(lienholder).length > 0) submitPayload.lienholder = lienholder;

    // ── Step 6: Submit ─────────────────────────────────────────────────
    //
    // The moment before this call is the last one at which "nothing happened" is
    // knowable. From here, a timeout or a dropped connection means TecAssured may
    // have created real paperwork we never heard about, so the flag below changes
    // what the catch does: Idle if we never asked, Submit Status Unknown if we
    // did and did not get an answer.
    providerWasCalled = true;
    const submitResponse = await client.submitContract(submitPayload);
    const response = (submitResponse ?? {}) as Record<string, unknown>;

    // A refusal is a clear answer: it declined, so nothing exists and the lock
    // goes back. Only silence is ambiguous.
    if (response.error && String(response.error).trim() !== "") {
      return await refuse(400, {
        error: `TecAssured contract submit failed: ${response.error}`,
        tecassured_error: response.error,
      });
    }

    const contracts = (Array.isArray(response.contracts) ? response.contracts : []) as Record<string, unknown>[];

    // A contract entry can carry its own error while the call itself is a 200
    // with no top-level error. Those are failures, not contracts, and must not
    // be written to agreement_products as though paperwork exists.
    const failed = contracts.filter(
      (c) => typeof c.error === "string" && c.error.trim() !== ""
    );
    if (failed.length > 0 && failed.length === contracts.length) {
      return await refuse(400, {
        error: "The provider refused every contract in this submit.",
        failures: failed.map((c) => ({
          rate_unique_id: c.rateUniqueId ?? c.rateUnique ?? null,
          provider_product_id: c.productId ?? null,
          detail: c.error,
        })),
      });
    }

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
      // Contracts now exist at TecAssured with nothing here pointing at them.
      // The session is parked at Submit Status Unknown rather than released:
      // the next submit would create a second set of the same paperwork,
      // because the rows that would have stopped it are the rows that failed
      // to write. This needs a person, not a retry.
      console.error(`Failed to store agreement: ${agreementErr?.message}`);
      await markUnknown(
        `The provider returned ${contracts.length} contract(s) ` +
          `(${contracts.map((c) => c.contractNumber ?? "no number").join(", ")}) ` +
          `but the agreement could not be recorded: ${agreementErr?.message}`
      );
      return json(500, {
        error:
          "Contracts were submitted to TecAssured but the agreement could not be recorded. " +
          "Do not retry; the contracts may already exist. Staff must check TecAssured " +
          "before this session can submit again.",
        detail: agreementErr?.message,
        submit_state: "Submit Status Unknown",
        tecassured_response: submitResponse,
      });
    }

    // ── Step 8: The customer's choices ─────────────────────────────────
    // Upserted on (session_id, provider_id, provider_product_id), the same key the planner's
    // autosave uses, so a product the customer already decided on is updated
    // rather than duplicated.
    const now = new Date().toISOString();
    const selectedRows = resolved.map((r) => ({
      session_id,
      provider_id: store.providerId,
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
      .upsert(selectedRows, { onConflict: "session_id,provider_id,provider_product_id" })
      .select("id, provider_product_id");

    if (selErr || !selectedSaved) {
      // Same reasoning as the agreement failure above: the paperwork is real
      // and this side of it is incomplete, so the session stays blocked.
      console.error(`Failed to store selected products: ${selErr?.message}`);
      await markUnknown(
        `The provider returned ${contracts.length} contract(s) but the selections ` +
          `could not be recorded: ${selErr?.message}`
      );
      return json(500, {
        error:
          "Contracts were submitted to TecAssured but the selections could not be recorded. " +
          "Do not retry; the contracts may already exist. Staff must check TecAssured " +
          "before this session can submit again.",
        detail: selErr?.message,
        submit_state: "Submit Status Unknown",
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
      if (typeof c.error === "string" && c.error.trim() !== "") {
        unmatched.push({ rate_unique_id: c.rateUniqueId ?? null, error: c.error });
        continue;
      }
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
        provider_id: store.providerId,
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
        // The word that makes the "one live contract per product" index bite.
        // Voiding is what changes it, in fni-contract-void.
        status: "Live",
      });
    }

    if (productRows.length > 0) {
      const { error: prodErr } = await supabase
        .schema("fni")
        .from("agreement_products")
        .insert(productRows);

      if (prodErr) {
        // This is also where a genuinely simultaneous second submit lands: the
        // partial unique index on (agreement_id, provider_product_id) refuses
        // the duplicate row. Either way real contracts exist and our record of
        // them does not, so the session is blocked for a person to sort out.
        console.error(`Failed to store agreement products: ${prodErr.message}`);
        await markUnknown(
          `The provider returned ${contracts.length} contract(s) ` +
            `(${contracts.map((c) => c.contractNumber ?? "no number").join(", ")}) ` +
            `but they could not be recorded: ${prodErr.message}`
        );
        return json(500, {
          error:
            "Contracts were submitted to TecAssured but could not be recorded. " +
            "Do not retry; the contracts may already exist. Staff must check TecAssured " +
            "before this session can submit again.",
          detail: prodErr.message,
          submit_state: "Submit Status Unknown",
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

    // Everything that could go wrong has either gone right or returned above,
    // and the agreement_products rows are now the thing that stops a second
    // contract for these products. The lock has done its job; let it go.
    await releaseLock();

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
      // A partial retry: these products were already done before this call and
      // were not sent again. Reported so the caller sees the whole deal, not
      // just the part this request happened to create.
      already_contracted:
        already.length > 0
          ? already.map((c) => ({
              contract_number: c.contract_number,
              provider_product_id: c.provider_product_id,
              product_name: c.product_name,
              status: c.status,
            }))
          : undefined,
      // Present only when TecAssured returned a contract we could not tie back
      // to a selection. Never silently dropped.
      unmatched_contracts: unmatched.length > 0 ? unmatched : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-contract-submit error:", message);

    // The whole reason providerWasCalled exists. A timeout or a dropped
    // connection after the submit call means TecAssured may have created real
    // paperwork we never heard about, and there is no way to tell from here.
    // So: release the lock if we never asked, and park the session at Submit
    // Status Unknown if we did. Nothing retries on its own -- a person checks
    // TecAssured, then voids or clears.
    if (lockHeld) {
      if (providerWasCalled) {
        await markUnknown(`The submit call failed after reaching the provider: ${message}`);
        return json(500, {
          error:
            "The submit reached TecAssured but we never learned the outcome: " +
            message +
            ". It may have created contracts. Staff must check TecAssured before " +
            "this session can submit again. Nothing will be retried automatically.",
          submit_state: "Submit Status Unknown",
        });
      }
      await releaseLock();
    }

    return json(500, { error: message });
  }
});
