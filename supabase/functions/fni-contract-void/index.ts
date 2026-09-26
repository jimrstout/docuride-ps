// fni-contract-void/index.ts
//
// Staff-only. The other half of "there is never more than one live contract for
// the same product on the same deal."
//
// Migration 0015 made that rule structural: a partial unique index on
// fni.agreement_products (agreement_id, provider_product_id) covering the rows
// whose status is Live or Submit Status Unknown. fni-contract-submit therefore
// refuses a product that already has one, and tells whoever asked to void it
// first. Before this function existed there was no "first" to do: the refusal
// was a dead end, because nothing in DocuRide could free the slot.
//
// So this is the release valve, and it is deliberately a staff action rather
// than something the submit path does on its own. Voiding somebody's contract
// is not a side effect of them changing their mind about a deductible.
//
// Two actions, both taken by a person:
//
//   Void
//     Voids the contract at TecAssured, then marks the row Voided with who and
//     when. The provider call comes first: a row marked Voided while the
//     contract is still live at TecAssured is worse than no row at all, because
//     it invites a second contract for the same product.
//
//   Clear Submit Status Unknown
//     A submit that reached TecAssured and never came back leaves the session
//     parked at Submit Status Unknown, blocking further submits, because from
//     here there is no way to tell whether real paperwork exists. Nothing
//     retries on its own and nothing clears on a timer. A person checks
//     TecAssured and says which it was: no contracts, so carry on; or
//     contracts exist, and they void them here first.
//
// Input (POST JSON):
//   session_id        - fni.sessions UUID (required)
//   action            - "Void" (default) or "Clear Submit Status Unknown"
//   contract_number   - the contract to void (required for Void)
//   staff_email       - who is doing this (required; recorded)
//   note              - optional free text, recorded on the session
//
// Auth: FNI_WEBHOOK_SECRET via ?secret= query param or x-webhook-secret header.
// Never reachable from a browser: the planner and the console both go through
// the server side, which holds the secret.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createTecAssuredClient } from "../_shared/tecassured.ts";
import { secretsMatch } from "../_shared/supabase.ts";
import { describeContract, type ContractRef } from "../_shared/duplicates.ts";

const ACTION_VOID = "Void";
const ACTION_CLEAR = "Clear Submit Status Unknown";

interface VoidRequest {
  session_id?: string;
  action?: string;
  contract_number?: string;
  staff_email?: string;
  note?: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** TecAssured answers a refusal with HTTP 200 and an `error` string. */
function providerError(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const err = (response as { error?: unknown }).error;
  if (typeof err === "string" && err.trim() !== "") return err.trim();
  return null;
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = new URL(req.url);
  const presented =
    url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
  if (!secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }

  let body: VoidRequest;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const session_id = body.session_id;
  const action = (body.action ?? ACTION_VOID).trim();
  const staffEmail = (body.staff_email ?? "").trim();

  if (!session_id) return json(400, { error: "session_id is required" });
  if (!staffEmail) {
    return json(400, {
      error: "staff_email is required. Voiding a contract is recorded against a person.",
    });
  }
  if (action !== ACTION_VOID && action !== ACTION_CLEAR) {
    return json(400, {
      error: `action must be "${ACTION_VOID}" or "${ACTION_CLEAR}"`,
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { data: session, error: sessErr } = await supabase
      .schema("fni")
      .from("sessions")
      .select("id, store_id, is_test, dealer_code_used, submit_state, submit_detail")
      .eq("id", session_id)
      .single();

    if (sessErr || !session) return json(404, { error: `Session ${session_id} not found` });

    // ── Clear Submit Status Unknown ────────────────────────────────────
    //
    // Only ever the answer to "I have looked". It puts the session back to Idle
    // so a submit can be attempted again, and keeps what the staff member said
    // in submit_detail rather than wiping the history of the incident.
    if (action === ACTION_CLEAR) {
      if (session.submit_state !== "Submit Status Unknown") {
        return json(409, {
          error:
            `This session is not blocked. Its submit state is "${session.submit_state}", ` +
            `and there is nothing to clear.`,
          submit_state: session.submit_state,
        });
      }

      const cleared =
        `Cleared by ${staffEmail} on ${new Date().toISOString()} after checking TecAssured. ` +
        (body.note?.trim() ? `Note: ${body.note.trim()}. ` : "") +
        `Previously: ${session.submit_detail ?? "no detail recorded"}`;

      const { error: clearErr } = await supabase
        .schema("fni")
        .from("sessions")
        .update({
          submit_state: "Idle",
          submit_started_at: null,
          submit_token: null,
          submit_detail: cleared,
        })
        .eq("id", session_id)
        .eq("submit_state", "Submit Status Unknown");

      if (clearErr) return json(500, { error: clearErr.message });

      return json(200, {
        session_id,
        action: ACTION_CLEAR,
        submit_state: "Idle",
        cleared_by: staffEmail,
        message:
          "This session can submit again. Any contract you found at TecAssured should be " +
          "voided here first, so DocuRide and TecAssured agree on what is live.",
      });
    }

    // ── Void ──────────────────────────────────────────────────────────
    const contractNumber = (body.contract_number ?? "").trim();
    if (!contractNumber) {
      return json(400, { error: "contract_number is required to void a contract" });
    }

    const { data: agreements } = await supabase
      .schema("fni")
      .from("agreements")
      .select("id")
      .eq("session_id", session_id);

    const agreementIds = ((agreements ?? []) as { id: string }[]).map((a) => a.id);
    if (agreementIds.length === 0) {
      return json(404, { error: "This session has no agreement, so it has no contracts." });
    }

    const { data: rows, error: rowErr } = await supabase
      .schema("fni")
      .from("agreement_products")
      .select("id, provider_product_id, contract_number, product_name, status")
      .in("agreement_id", agreementIds)
      .eq("contract_number", contractNumber);

    if (rowErr) return json(500, { error: rowErr.message });

    const row = (rows ?? [])[0] as
      | (ContractRef & { id: string })
      | undefined;

    if (!row) {
      return json(404, {
        error: `Contract ${contractNumber} is not recorded on this session.`,
      });
    }

    // Already voided is not a failure. Whoever asked wanted this contract not
    // to be live, and it is not live, so the answer is the same answer.
    if (row.status === "Voided") {
      return json(200, {
        session_id,
        action: ACTION_VOID,
        already_voided: true,
        contract_number: contractNumber,
        message: `${describeContract(row)} was already voided. Nothing was sent to TecAssured.`,
      });
    }

    let store;
    try {
      store = await createTecAssuredClient(session.store_id, supabase);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
    const { client, dealerCode } = store;

    // Same rule as documents: void as the dealer that submitted. A store that
    // has since been repointed must not void under a different Dealer ID.
    if (session.dealer_code_used && session.dealer_code_used !== dealerCode) {
      return json(409, {
        error:
          `This session was submitted under Dealer ID ${session.dealer_code_used}, but the store ` +
          `now maps to ${dealerCode}. A contract must be voided under the Dealer ID that submitted it.`,
        submitted_under: session.dealer_code_used,
        store_maps_to: dealerCode,
      });
    }

    // TecAssured first, the row second. The other order would free the
    // one-live-contract slot while the contract was still live over there.
    const response = await client.voidContract(
      row.provider_product_id,
      contractNumber
    );

    const err = providerError(response);
    if (err) {
      return json(400, {
        error: `TecAssured refused to void ${contractNumber}: ${err}`,
        contract_number: contractNumber,
        tecassured_response: response,
      });
    }

    const { error: updErr } = await supabase
      .schema("fni")
      .from("agreement_products")
      .update({
        status: "Voided",
        voided_at: new Date().toISOString(),
        voided_by: staffEmail,
      })
      .eq("id", row.id);

    if (updErr) {
      // The contract is void at TecAssured and still Live here, which reads as
      // a slot that is taken when it is not. Said out loud: the fix is to run
      // this again, which is safe because voiding an already-void contract is
      // refused by the provider and handled above.
      console.error(`Voided at TecAssured but not recorded: ${updErr.message}`);
      return json(500, {
        error:
          `Contract ${contractNumber} was voided at TecAssured but the record could not be ` +
          `updated: ${updErr.message}. Run this again.`,
        contract_number: contractNumber,
      });
    }

    return json(200, {
      session_id,
      action: ACTION_VOID,
      contract_number: contractNumber,
      provider_product_id: row.provider_product_id,
      product_name: row.product_name,
      status: "Voided",
      voided_by: staffEmail,
      dealer_code: dealerCode,
      is_test: session.is_test === true,
      message:
        `${describeContract(row)} is voided. This product can be submitted again on this deal.`,
      tecassured_response: response,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("fni-contract-void error:", message);
    return json(500, { error: message });
  }
});
