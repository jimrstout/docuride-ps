// _shared/agreement-void.ts: a contract record whose every product is voided
// is Voided itself.
//
// A void changed only the product (fni.agreement_products), so the parent
// fni.agreements row went on saying Finalized with nothing live under it:
// 15029 since 28 Oct, 13759 since all four of its contracts were voided on
// 3 Nov. Now the void that leaves no product unvoided under an agreement sets
// that agreement to Voided. A later submit on the deal upserts the same row
// back to Draft (fni-contract-submit), as it always has.
//
// Only the status changes. A failure is logged, never thrown: the void is
// done at the provider and on the product, and must still be reported done.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const AGREEMENT_VOIDED = "Voided";

/** Every product under the agreement is voided, and there is at least one. */
export function allProductsVoided(products: { status: string | null }[]): boolean {
  return products.length > 0 && products.every((p) => p.status === "Voided");
}

/** After a void: set the agreement to Voided when nothing under it is left unvoided. Returns whether it did. */
export async function voidAgreementIfAllVoided(supabase: SupabaseClient, agreementId: string | null): Promise<boolean> {
  if (!agreementId) return false;
  try {
    const { data, error } = await supabase
      .schema("fni")
      .from("agreement_products")
      .select("status")
      .eq("agreement_id", agreementId);
    if (error) throw new Error(error.message);
    if (!allProductsVoided((data ?? []) as { status: string | null }[])) return false;
    const { error: updErr } = await supabase
      .schema("fni")
      .from("agreements")
      .update({ status: AGREEMENT_VOIDED })
      .eq("id", agreementId)
      .neq("status", AGREEMENT_VOIDED);
    if (updErr) throw new Error(updErr.message);
    return true;
  } catch (err) {
    console.error("agreement-void: the contract record's status was not changed", {
      agreement: agreementId,
      problem: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
