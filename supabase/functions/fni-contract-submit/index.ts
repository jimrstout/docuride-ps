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
import { RECORDED_BY_STAFF, splitSelections } from "../_shared/oem-contracts.ts";
import { contractCallRefusal } from "../_shared/contract-guard.ts";
import { atMaximum, pricePolicy } from "../_shared/price-cap.ts";
import { readSubmitResponse } from "../_shared/submit-outcome.ts";
import { alignContractDates, dealDates, SALE_DATE_MISSING } from "../_shared/deal-dates.ts";
import { storeToday, submitDateProblem } from "../_shared/store-day.ts";
import { applyStaffEdits, parseStaffEdits } from "../_shared/staff-edits.ts";
import { DX1_CONFIRMATION, partyChanges } from "../_shared/contract-parties.ts";
import { applyCobuyerProbe, probeDecision, type MarkerRow } from "../_shared/cobuyer-probe.ts";
import { programName } from "../_shared/program-names.ts";
import { savedSelections, type SavedSelection } from "../_shared/saved-selections.ts";

// ─── Types ───────────────────────────────────────────────────────────────

interface ContractSubmitRequest {
  session_id: string;
  selections: ProductSelection[];
  /**
   * Submit what the customer chose in the planner, as saved, instead of a
   * list sent with the request. What Verify's Submit button sends.
   */
  use_saved_selections?: boolean;
  /** TEMPORARY: the co-buyer field probe (_shared/cobuyer-probe.ts). */
  cobuyer_probe?: boolean;
  /** "All", 1, 2 or 3. "All" when left out. */
  cobuyer_probe_batch?: unknown;
  /**
   * The person submitting confirms the contract details changed on Details
   * have been made in DX1 too, or are not needed there. Required only when
   * something was changed (_shared/contract-parties.ts).
   */
  dx1_confirmed?: boolean;
  /** Who confirmed, for the session event. */
  confirmed_by?: string;
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

  const { session_id } = body;
  if (!session_id) return json(400, { error: "session_id is required" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── The customer's saved choices, when asked for ───────────────────
  if (body.use_saved_selections === true) {
    const { data: saved, error: savedErr } = await supabase
      .schema("fni")
      .from("selected_products")
      .select("provider_product_id, rate_unique_id, selected_options, customer_price, retail_price")
      .eq("session_id", session_id)
      .eq("disposition", "Included");
    if (savedErr) return json(500, { error: `The customer's choices could not be read: ${savedErr.message}` });
    body.selections = savedSelections((saved ?? []) as SavedSelection[]);
    if (body.selections.length === 0) {
      return json(400, { error: "The customer has not chosen any products in the planner yet, so there is nothing to submit." });
    }
  }
  if (!Array.isArray(body.selections) || body.selections.length === 0) {
    return json(400, { error: "At least one product selection is required" });
  }

  // ── OEM selections are never sent ──────────────────────────────────
  // A product from a Price Sheet provider is contracted on the OEM's own
  // system and recorded by staff (fni-oem-contracts). It is held back here,
  // before the lock or any provider call, and reported, so a menu that mixes
  // OEM and Riders Advantage products can still submit the Riders Advantage
  // ones and nothing else.
  const { data: recordedRows } = await supabase
    .schema("fni")
    .from("selected_products")
    .select("rate_unique_id, product_name, providers!inner(contract_method)")
    .eq("session_id", session_id)
    .eq("providers.contract_method", RECORDED_BY_STAFF);
  const recordedNames = new Map(
    ((recordedRows ?? []) as { rate_unique_id: string; product_name: string }[]).map((r) => [r.rate_unique_id, r.product_name])
  );
  const { toProvider: selections, recordedByStaff } = splitSelections(body.selections, new Set(recordedNames.keys()));
  const recordedByStaffReport = recordedByStaff.map((s) => ({
    rate_unique: s.rate_unique,
    product_name: recordedNames.get(s.rate_unique) ?? null,
    note: "An OEM product. Its contract is written on the OEM's own system and recorded by staff on Verify. It was not sent.",
  }));
  if (selections.length === 0) {
    return json(400, {
      error:
        "Every selection is an OEM product, and OEM contracts are recorded by staff on Verify, " +
        "not submitted. Nothing was sent.",
      recorded_by_staff: recordedByStaffReport,
    });
  }

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

    // ── Step 3b: Test contracts only, on the QA server ─────────────────
    // While DocuRide is being tested a contract may go only to TecAssured's
    // QA server, and only for a cleared deal or a test session. Checked
    // before anything is sent. See _shared/contract-guard.ts.
    const notCleared = contractCallRefusal(session, credentials.api_base_url, "submitted");
    if (notCleared) return await refuse(403, { error: notCleared });

    // ── Step 3c: The deal's dates ──────────────────────────────────────
    // A contract carries the sale date and the in-service date, and neither is
    // ever made up: no sale date, or a used unit with no in-service date, and
    // nothing is sent (_shared/deal-dates.ts).
    // Staff corrections first: a used unit's in-service date is entered on Verify.
    const dates = dealDates(applyStaffEdits(session as Record<string, unknown>, parseStaffEdits(session.staff_edits)));
    if (dates.problem || dates.sale === null || dates.inService === null) {
      return await refuse(400, { error: dates.problem ?? SALE_DATE_MISSING });
    }

    // ── Step 3d: Only on the day of the sale ───────────────────────────
    // Today in the store's own zone (public.stores.time_zone). A planned sale
    // date, set for preparing the deal the night before, must be that day too,
    // and the unit cannot go into service after it was sold (_shared/store-day.ts).
    const { data: storeRow } = await supabase
      .from("stores")
      .select("time_zone")
      .eq("id", session.store_id)
      .maybeSingle();
    const today = storeToday((storeRow as { time_zone?: string } | null)?.time_zone ?? null);
    const dayProblem = submitDateProblem({
      sale: dates.sale,
      inService: dates.inService,
      planned: typeof session.planned_sale_date === "string" ? session.planned_sale_date : null,
      today,
    });
    if (dayProblem) return await refuse(400, { error: dayProblem });

    // ── Step 3e: Contract details changed here, and DX1 ────────────────
    // The finance contract comes from DX1. Anything about the buyer, co-buyer
    // or lienholder changed on Details must be changed there too, so the
    // person submitting confirms it, and the confirmation is recorded.
    const changes = partyChanges(session as Record<string, unknown>, parseStaffEdits(session.staff_edits));
    if (changes.length > 0) {
      if (body.dx1_confirmed !== true) {
        return await refuse(400, {
          error:
            `These contract details were changed on Details: ${changes.map((c) => c.label).join(", ")}. ` +
            `Confirm "${DX1_CONFIRMATION}" and submit again.`,
          changes,
        });
      }
      const { error: confirmErr } = await supabase
        .schema("fni")
        .from("session_events")
        .insert({
          session_id,
          event: "Contract detail changes confirmed for DX1",
          detail: { confirmation: DX1_CONFIRMATION, changes },
          created_by: typeof body.confirmed_by === "string" && body.confirmed_by.trim() !== ""
            ? body.confirmed_by.trim()
            : "fni-contract-submit",
        });
      if (confirmErr) {
        return await refuse(500, { error: `The confirmation could not be recorded, so nothing was sent: ${confirmErr.message}` });
      }
    }

    // ── Step 4: Cut the quote down to what is being bought ────────────
    // Pruned, not flagged: see _shared/offer-selections.ts. Sending all
    // eleven products with flags is a request to submit all eleven, and the
    // QA server simply stopped responding when we did.
    const offerPayload = ratedOffer.response_payload as Record<string, unknown>;
    // What each product is submitted at (_shared/price-cap.ts). A test session
    // on the QA server goes at the maximum the QA dealer allows; everything
    // else at the customer's price, with TecAssured's answer deciding.
    const policy = pricePolicy(session, credentials.api_base_url);
    const customerPrice = new Map(selections.map((s) => [s.rate_unique, s.retail_price]));
    let { resolved } = buildSubmitQuote(offerPayload, selections);
    if (policy === "Test at maximum") {
      resolved = buildSubmitQuote(offerPayload, atMaximum(selections, resolved)).resolved;
    }

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

    // On the QA server a test submit is priced at the cap, so this guard can
    // only trip on a bug. Anywhere else no cap is assumed: dealer cost plus
    // markup is QA dealer 3-306's rule, not every dealer's, and TecAssured's
    // own answer is what decides.
    const overCap = policy === "Test at maximum" ? resolved.filter((r) => r.overCap) : [];
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

    // ── Step 4a: The co-buyer field probe (TEMPORARY) ──────────────────
    // Only past the QA-only guard above, only on a test session, only when
    // asked for, and only for forms that print a co-buyer name. Asked for
    // anywhere else, the flag is ignored. See _shared/cobuyer-probe.ts.
    const probe = probeDecision({
      requested: body.cobuyer_probe,
      batch: body.cobuyer_probe_batch,
      isTest: session.is_test === true,
      guardPassed: notCleared === null,
      products: resolved.map((r) => ({ name: r.productName, program: programName(r.productName) })),
    });
    if (probe.kind === "Refuse") return await refuse(400, { error: probe.message });

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
        .eq("agreement_id", (existingAgreement as { id: string }).id)
        // This provider's contracts only. A recorded OEM contract may share a
        // product code with a Riders Advantage product and must not block it.
        .eq("provider_id", store.providerId)
        .is("recorded_by", null);

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
        recorded_by_staff: recordedByStaffReport,
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
    // The staff value wherever one exists: the CRM's, corrected on Details,
    // and blank for a lienholder staff removed (_shared/contract-parties.ts).
    const party = applyStaffEdits(session as Record<string, unknown>, parseStaffEdits(session.staff_edits)) as Record<string, string | null>;
    if (party.buyer_first_name) submitQuote.buyerFirstName = party.buyer_first_name;
    if (party.buyer_last_name) submitQuote.buyerLastName = party.buyer_last_name;
    if (party.buyer_address) submitQuote.buyerAddress = party.buyer_address;

    const lienholder: Record<string, string> = {};
    if (party.lienholder_name) lienholder.lienholderName = party.lienholder_name;
    if (party.lienholder_address) lienholder.lienholderAddress = party.lienholder_address;
    if (party.lienholder_city) lienholder.lienholderCity = party.lienholder_city;
    if (party.lienholder_state) lienholder.lienholderState = party.lienholder_state;
    if (party.lienholder_zip) lienholder.lienholderZip = party.lienholder_zip;
    if (party.lienholder_phone) lienholder.lienholderPhone = party.lienholder_phone;

    // dealerCode is required at the top level and is NOT inferred from the
    // session. Without it the server answers {"error":"Missing Dealer Code."},
    // which is how this was found.
    const submitPayload: Record<string, unknown> = {
      dealerCode,
      quote: submitQuote,
    };
    if (Object.keys(lienholder).length > 0) submitPayload.lienholder = lienholder;

    // The quote's dates are the ones TecAssured echoed when it rated. Each is
    // made the session's own, so a contract never carries another day.
    const datesChanged = alignContractDates(submitQuote, { sale: dates.sale, inService: dates.inService });
    if (datesChanged.length > 0) console.log(`fni-contract-submit dates aligned: ${datesChanged.join("; ")}`);

    // ── Step 5b: The co-buyer field probe (TEMPORARY) ──────────────────
    // Marker codes only, added after the real buyer and never over any key
    // already there. Recorded on the session before anything is sent, so the
    // record exists even if the call never answers.
    let probeMarkers: MarkerRow[] | null = null;
    if (probe.kind === "On") {
      probeMarkers = applyCobuyerProbe(submitQuote, submitPayload, probe.batch);
      const { error: eventErr } = await supabase
        .schema("fni")
        .from("session_events")
        .insert({
          session_id,
          event: "Co-buyer field probe sent",
          detail: {
            batch: probe.batch === "All" ? "All" : `Batch ${probe.batch}`,
            products: toSubmit.map((r) => r.productName),
            markers: probeMarkers,
          },
          created_by: "fni-contract-submit",
        });
      if (eventErr) {
        return await refuse(500, {
          error: `The co-buyer field test could not be recorded on the session (${eventErr.code ?? "error"}), so nothing was sent.`,
        });
      }
    }

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

    // ── Step 6b: Read the answer, product by product ──────────────────
    //
    // TecAssured can report a submit as failed while contracts were created
    // (deal 13437: Tire and Wheel refused, Battery and Theft created, a
    // top-level error, and nothing recorded). So the answer is never read by
    // its top-level error alone: see _shared/submit-outcome.ts. A clear no for
    // every product hands the lock back; anything created is recorded below;
    // anything that cannot be accounted for parks the session at Submit Status
    // Unknown.
    const reading = readSubmitResponse(
      response,
      toSubmit.map((r) => ({ rateUniqueId: r.rateUniqueId, productName: r.productName }))
    );

    if (reading.refusedOutright) {
      if (probe.kind === "On") {
        // TecAssured's own words, exactly. An "unknown field" error says
        // something about the probe, and Jim decides whether to run the
        // batches. Nothing is retried, stripped or switched here.
        const verbatim = [
          typeof response.error === "string" ? response.error : "",
          ...(Array.isArray(response.contracts) ? response.contracts : [])
            .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>).error : null))
            .filter((e): e is string => typeof e === "string" && e.trim() !== ""),
        ].filter((e) => e.trim() !== "");
        return await refuse(400, {
          error: verbatim.length > 0 ? verbatim.join(" | ") : JSON.stringify(response),
          tecassured_error: response.error ?? null,
          cobuyer_probe: { batch: probe.batch, markers: probeMarkers },
          products: reading.products,
        });
      }
      return await refuse(400, {
        error: reading.message,
        tecassured_error: response.error ?? null,
        products: reading.products,
      });
    }

    if (reading.created.length === 0) {
      // Nothing we can record, and no clear no either.
      await markUnknown(reading.message);
      return json(502, {
        error: reading.message,
        submit_state: "Submit Status Unknown",
        products: reading.products,
        tecassured_response: submitResponse,
      });
    }

    const contracts = reading.created;

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
      // The customer's price, as they chose it. A test submit at the maximum
      // changes what the contract says, never what the customer chose.
      retail_price: customerPrice.get(r.rateUniqueId) ?? r.selection.retail_price,
      customer_price: customerPrice.get(r.rateUniqueId) ?? r.selection.retail_price,
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
      // Each contract's place on the deal, in submit order, after any already
      // there (voided ones keep theirs). It is the "01" in the WorkDrive file
      // name, so it is given once and never changed. See _shared/document-names.ts.
      const { data: placed } = await supabase
        .schema("fni")
        .from("agreement_products")
        .select("document_position")
        .eq("agreement_id", agreement.id)
        .not("document_position", "is", null);
      const taken = ((placed ?? []) as { document_position: number }[]).map((r) => r.document_position);
      let next = (taken.length > 0 ? Math.max(...taken) : 0) + 1;
      for (const row of productRows) row.document_position = next++;

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
    // Agreement Created once any contract is on record. A product the answer
    // did not account for keeps the lock at Submit Status Unknown, for a
    // person to check against TecAssured.
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
    // contract for these products. The lock has done its job; let it go,
    // unless part of the answer cannot be accounted for.
    if (reading.unknown) await markUnknown(reading.message);
    else await releaseLock();

    return json(200, {
      session_id,
      status: "Agreement Created",
      // Product by product: created, refused, or not known.
      message: reading.message,
      // TEMPORARY: which markers went out, to read the contract against.
      ...(probe.kind === "On" ? { cobuyer_probe: { batch: probe.batch, markers: probeMarkers } } : {}),
      products: reading.products,
      partial: reading.products.some((p) => p.outcome !== "Created"),
      submit_state: reading.unknown ? "Submit Status Unknown" : "Idle",
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
      // OEM selections in the request, held back: they are recorded by staff.
      recorded_by_staff: recordedByStaffReport,
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
