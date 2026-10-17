// _shared/oem-contract-rows.ts
//
// Reading a deal's OEM selections and the contracts staff recorded for them.
// Used by fni-oem-contracts and by Verify's sheet. See _shared/oem-contracts.ts.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { contractStateLabel, OEM_BUCKET, RECORDED_BY_STAFF } from "./oem-contracts.ts";

export interface Selection {
  id: string;
  provider_id: string;
  product_type: string;
  product_name: string;
  provider_product_id: string;
  rate_unique_id: string;
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  dealer_cost: number | null;
  retail_price: number | null;
  customer_price: number | null;
  selected_options: unknown;
}

/** The deal's selections from providers whose contracts staff record. */
export async function oemSelections(supabase: SupabaseClient, sessionId: string) {
  const { data: providers } = await supabase
    .schema("fni")
    .from("providers")
    .select("id, name")
    .eq("contract_method", RECORDED_BY_STAFF);
  const names = new Map(((providers ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  if (names.size === 0) return { selections: [] as Selection[], names };

  const { data, error } = await supabase
    .schema("fni")
    .from("selected_products")
    .select(
      "id, provider_id, product_type, product_name, provider_product_id, rate_unique_id, term_months, " +
        "term_miles, deductible, dealer_cost, retail_price, customer_price, selected_options"
    )
    .eq("session_id", sessionId)
    .eq("disposition", "Included")
    .in("provider_id", [...names.keys()]);
  if (error) throw new Error(`Failed to read the selections: ${error.message}`);
  return { selections: (data ?? []) as unknown as Selection[], names };
}

export async function agreementId(supabase: SupabaseClient, sessionId: string, create: boolean): Promise<string | null> {
  const read = async () => {
    const { data } = await supabase.schema("fni").from("agreements").select("id").eq("session_id", sessionId).maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };
  const found = await read();
  if (found || !create) return found;
  // One agreement per session. A recorded OEM contract opens it as a Draft and
  // never changes it afterwards: its status is about the API submit's papers.
  await supabase
    .schema("fni")
    .from("agreements")
    .upsert({ session_id: sessionId, status: "Draft" }, { onConflict: "session_id", ignoreDuplicates: true });
  return await read();
}

export async function contractsFor(supabase: SupabaseClient, sessionId: string) {
  const id = await agreementId(supabase, sessionId, false);
  if (!id) return [];
  const { data, error } = await supabase
    .schema("fni")
    .from("agreement_products")
    .select(
      "id, selected_product_id, provider_id, provider_product_id, product_name, contract_number, status, " +
        "recorded_by, recorded_at, voided_by, voided_at, void_reason, document_path, filename"
    )
    .eq("agreement_id", id)
    .not("recorded_by", "is", null);
  if (error) throw new Error(`Failed to read the recorded contracts: ${error.message}`);
  return (data ?? []) as unknown as Record<string, unknown>[];
}

/** The deal's OEM selections, each with its recorded contract, if any. */
export async function oemContractList(supabase: SupabaseClient, sessionId: string) {
  const [{ selections, names }, contracts] = await Promise.all([
    oemSelections(supabase, sessionId),
    contractsFor(supabase, sessionId),
  ]);
  const withLinks = await Promise.all(
    contracts.map(async (c) => {
      const { data } = await supabase.storage.from(OEM_BUCKET).createSignedUrl(c.document_path as string, 600);
      return {
        selected_product_id: c.selected_product_id,
        product_name: c.product_name,
        contract_number: c.contract_number,
        state: contractStateLabel(c as { status: string; recorded_by: string | null }),
        recorded_by: c.recorded_by,
        recorded_at: c.recorded_at,
        voided_by: c.voided_by,
        voided_at: c.voided_at,
        void_reason: c.void_reason,
        filename: c.filename,
        document_url: data?.signedUrl ?? null,
      };
    })
  );
  return selections.map((s) => {
      const recorded = withLinks.filter((c) => c.selected_product_id === s.id);
      return {
        selected_product_id: s.id,
        provider_name: names.get(s.provider_id) ?? "An OEM program",
        product_name: s.product_name,
        term_months: s.term_months,
        customer_price: s.customer_price ?? s.retail_price,
        contract: recorded.find((c) => c.state === "Recorded") ?? null,
        voided: recorded.filter((c) => c.state === "Voided"),
      };
    });
}

