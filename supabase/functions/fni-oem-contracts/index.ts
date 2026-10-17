// fni-oem-contracts: OEM contracts, recorded by staff.
//
// GET  ?session_id=   the deal's OEM selections, each with the contract
//                     recorded for it, if any
// POST { action: "upload_url", session_id, file_name }
//        a one-time URL the browser puts the signed contract to, straight into
//        the private oem-contracts bucket
// POST { action: "record", session_id, selected_product_id, contract_number,
//        recorded_by, document_path }
// POST { action: "void", session_id, contract_number, voided_by, void_reason }
//
// A Price Sheet provider has no API. Its contracts are written on the OEM's
// own system, and this records that it was done: the contract number, the
// signed document, who and when. Nothing here calls TecAssured or any other
// provider, and nothing is deleted: a mistaken record is voided, with a reason.
// See docs/multi-provider.md, section 10.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { documentPathFor, OEM_BUCKET, parseRecord, parseVoid } from "../_shared/oem-contracts.ts";
import { agreementId, contractsFor, oemContractList, oemSelections } from "../_shared/oem-contract-rows.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function list(supabase: SupabaseClient, sessionId: string): Promise<Response> {
  return json(200, { selections: await oemContractList(supabase, sessionId) });
}

async function uploadUrl(supabase: SupabaseClient, sessionId: string, body: Record<string, unknown>): Promise<Response> {
  const fileName = text(body.file_name);
  if (fileName === "") return json(400, { error: "Choose the signed contract to upload." });
  const target = documentPathFor(sessionId, fileName, crypto.randomUUID());
  if ("error" in target) return json(400, { error: target.error });
  const { data, error } = await supabase.storage.from(OEM_BUCKET).createSignedUploadUrl(target.path);
  if (error || !data) return json(502, { error: `An upload could not be started: ${error?.message ?? "no URL"}` });
  return json(200, { document_path: target.path, signed_url: data.signedUrl });
}

async function record(supabase: SupabaseClient, sessionId: string, body: Record<string, unknown>): Promise<Response> {
  const parsed = parseRecord(body, sessionId);
  if (!parsed.fields) return json(400, { error: parsed.errors.join(" ") });
  const f = parsed.fields;

  const { selections, names } = await oemSelections(supabase, sessionId);
  const sel = selections.find((s) => s.id === f.selected_product_id);
  if (!sel) {
    return json(400, {
      error: "That is not one of this deal's OEM selections. Only a product the customer chose from an OEM program is recorded here.",
    });
  }
  if (sel.dealer_cost === null) {
    return json(400, { error: `${sel.product_name} has no dealer cost on its selection. Present the menu again before recording it.` });
  }
  const price = sel.customer_price ?? sel.retail_price;
  if (price === null) {
    return json(400, { error: `${sel.product_name} has no customer price on its selection. Present the menu again before recording it.` });
  }

  // The file must be there: the browser put it straight into the bucket.
  const folder = f.document_path.slice(0, f.document_path.lastIndexOf("/"));
  const { data: files } = await supabase.storage.from(OEM_BUCKET).list(folder);
  if (!((files ?? []) as { name: string }[]).some((o) => o.name === f.filename)) {
    return json(400, { error: "The signed contract could not be found. Upload it again." });
  }

  const agreement = await agreementId(supabase, sessionId, true);
  if (!agreement) return json(500, { error: "The deal's agreement could not be opened." });

  const now = new Date().toISOString();
  const { error } = await supabase.schema("fni").from("agreement_products").insert({
    agreement_id: agreement,
    selected_product_id: sel.id,
    provider_id: sel.provider_id,
    product_type: sel.product_type,
    product_name: sel.product_name,
    provider_product_id: sel.provider_product_id,
    rate_unique_id: sel.rate_unique_id,
    term_months: sel.term_months,
    term_miles: sel.term_miles,
    deductible: sel.deductible,
    final_dealer_cost: sel.dealer_cost,
    final_customer_price: price,
    selected_options: sel.selected_options,
    contract_number: f.contract_number,
    status: "Live",
    recorded_by: f.recorded_by,
    recorded_at: now,
    document_path: f.document_path,
    filename: f.filename,
  });
  if (error) {
    // agreement_products_one_live_per_product: one live contract per product.
    return error.code === "23505"
      ? json(409, { error: `${sel.product_name} already has a contract recorded on this deal. Void it first to record another.` })
      : json(500, { error: `The contract could not be recorded: ${error.message}` });
  }
  return json(200, {
    ok: true,
    message: `${names.get(sel.provider_id) ?? "The OEM"} contract ${f.contract_number} for ${sel.product_name} is recorded.`,
  });
}

async function voidRecorded(supabase: SupabaseClient, sessionId: string, body: Record<string, unknown>): Promise<Response> {
  const parsed = parseVoid(body);
  if (!parsed.fields) return json(400, { error: parsed.errors.join(" ") });
  const f = parsed.fields;
  const row = (await contractsFor(supabase, sessionId)).find(
    (c) => c.contract_number === f.contract_number && c.status === "Live"
  );
  if (!row) return json(404, { error: `No recorded contract ${f.contract_number} is live on this deal.` });

  const { error } = await supabase
    .schema("fni")
    .from("agreement_products")
    .update({ status: "Voided", voided_at: new Date().toISOString(), voided_by: f.voided_by, void_reason: f.void_reason })
    .eq("id", row.id as string)
    .eq("status", "Live");
  if (error) return json(500, { error: `The contract could not be voided: ${error.message}` });
  return json(200, {
    ok: true,
    message:
      `Contract ${f.contract_number} is voided here. Nothing was sent to any provider: ` +
      `void it on the OEM's own system too, if that has not been done.`,
  });
}

serve(async (req: Request) => {
  if (!secretsMatch(req.headers.get("x-webhook-secret"), Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    if (req.method === "GET") {
      const sessionId = new URL(req.url).searchParams.get("session_id") ?? "";
      if (!UUID_RE.test(sessionId)) return json(400, { error: "Which deal is missing." });
      return await list(supabase, sessionId);
    }
    if (req.method !== "POST") return json(405, { error: "GET or POST only" });

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
    const sessionId = text(body.session_id);
    if (!UUID_RE.test(sessionId)) return json(400, { error: "Which deal is missing." });
    const { data: session } = await supabase.schema("fni").from("sessions").select("id").eq("id", sessionId).maybeSingle();
    if (!session) return json(404, { error: "That deal no longer exists." });

    switch (body.action) {
      case "upload_url":
        return await uploadUrl(supabase, sessionId, body);
      case "record":
        return await record(supabase, sessionId, body);
      case "void":
        return await voidRecorded(supabase, sessionId, body);
      default:
        return json(400, { error: "Unknown action." });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("fni-oem-contracts error:", message);
    return json(500, { error: message });
  }
});
