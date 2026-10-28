// _shared/provider-rows.ts
//
// Reading providers and a session's rating attempts from the database.
//
// A session has one fni.rated_offers row per provider (0021), so nothing may
// read "the" row for a session any more. These are the reads that replace it.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * One store's account with a provider.
 *
 * A Connected provider's account carries the login (credential_id) and this
 * store's Dealer ID on it (dealer_code). A Price Sheet provider has neither,
 * so both are nullable here and checked by the code that needs them.
 */
export interface StoreProviderAccount {
  id: string;
  store_id: string;
  provider_id: string;
  credential_id: string | null;
  dealer_code: string | null;
  active: boolean;
}

/** The provider an account belongs to, as embedded in a read of it. */
export interface AccountProvider {
  id: string;
  name: string;
  kind: string;
  adapter: string | null;
}

/**
 * A store's active account with the provider whose adapter is TecAssured, with
 * that provider embedded, or null when the store has none.
 *
 * The one place that decides which store account TecAssured is called with.
 * Matching on the adapter rather than a provider's name means renaming
 * "Riders Advantage" in the admin area cannot disconnect it.
 */
export async function tecAssuredAccount(
  supabase: SupabaseClient,
  storeId: string
): Promise<(StoreProviderAccount & { provider: AccountProvider }) | null> {
  const { data, error } = await supabase
    .schema("fni")
    .from("store_provider_accounts")
    .select("*, provider:providers!inner(id, name, kind, adapter)")
    .eq("store_id", storeId)
    .eq("active", true)
    .eq("provider.adapter", "TecAssured")
    .eq("provider.active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read the TecAssured account for store ${storeId}: ${error.message}`);
  }
  return (data as unknown as (StoreProviderAccount & { provider: AccountProvider }) | null) ?? null;
}

/** The provider embedded in a read, as much of it as the callers use. */
export interface EmbeddedProvider {
  id: string;
  name: string;
  kind: string;
  adapter: string | null;
}

/** One provider's rating attempt for a session. */
export interface OfferRow {
  session_id: string;
  provider_id: string;
  state: string;
  request_payload: unknown;
  response_payload: unknown;
  product_count: number;
  rated_at: string | null;
  error_detail: string | null;
  out_of_date: boolean;
  /** Why the last re-rate failed, on a row whose earlier offers were kept. */
  last_failure_detail: string | null;
  last_failure_at: string | null;
  provider: EmbeddedProvider | null;
}

const PROVIDER_EMBED = "provider:providers(id, name, kind, adapter)";

/** Every provider's rating attempt for a session, with its provider. */
export async function offerRowsFor(
  supabase: SupabaseClient,
  sessionId: string
): Promise<OfferRow[]> {
  const { data, error } = await supabase
    .schema("fni")
    .from("rated_offers")
    .select(`*, ${PROVIDER_EMBED}`)
    .eq("session_id", sessionId);
  if (error) throw new Error(`Failed to read the rated offers: ${error.message}`);
  return (data ?? []) as unknown as OfferRow[];
}

/** The attempt made through the TecAssured adapter, or null. */
export function tecAssuredRow(rows: OfferRow[]): OfferRow | null {
  return rows.find((r) => r.provider?.adapter === "TecAssured") ?? null;
}

/**
 * The tenant's provider whose adapter is TecAssured.
 *
 * Matched on the adapter, not the name, so renaming "Riders Advantage" in the
 * admin area cannot disconnect it.
 */
export async function tecAssuredProviderId(
  supabase: SupabaseClient,
  tenantId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .schema("fni")
    .from("providers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("adapter", "TecAssured")
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(`Failed to read the TecAssured provider: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * The name staff know the tenant's TecAssured provider by, from its record
 * ("Riders Advantage"), or null. For the words on screens and in messages, so
 * none of them has a provider's name written in.
 */
export async function tecAssuredProviderName(
  supabase: SupabaseClient,
  tenantId: unknown
): Promise<string | null> {
  if (typeof tenantId !== "string" || tenantId === "") return null;
  const { data } = await supabase
    .schema("fni")
    .from("providers")
    .select("name")
    .eq("tenant_id", tenantId)
    .eq("adapter", "TecAssured")
    .eq("active", true)
    .maybeSingle();
  const name = (data as { name?: string | null } | null)?.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}
