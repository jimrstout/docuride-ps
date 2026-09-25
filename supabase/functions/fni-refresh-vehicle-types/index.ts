// fni-refresh-vehicle-types/index.ts
//
// Nightly cron job (about 3 AM Eastern) that refreshes the TecAssured vehicle
// types cache for every store with an active Dealer ID.
//
// Vehicle types are per DEALER, not per login: two stores on the same account
// can legitimately offer different types, so the cache lives on
// fni.store_provider_accounts alongside the dealer code it was fetched with,
// and not on the shared credential row. Caching them keeps a live API call out
// of the path when the F&I menu loads.
//
// ── One session for the whole sweep ─────────────────────────────────────
// The loop is over store MAPPINGS grouped by credential, so nine stores on one
// login authenticate once between them. Before this the loop was over
// credential rows, each of which was a store, so a nine-store sweep was nine
// logins against an API that is content with one.
//
// Triggered by pg_cron via HTTP POST with the service role key. No JWT
// verification: the caller is the scheduler.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  TecAssuredCredentials,
  StoreProviderAccount,
  EndpointNotFoundError,
  clientFor,
} from "../_shared/tecassured.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** TecAssured has returned both a bare array and a wrapper over one. */
function countTypes(types: unknown): number {
  if (Array.isArray(types)) return types.length;
  if (types && typeof types === "object") {
    const inner = (types as Record<string, unknown>).vehicleTypes;
    if (Array.isArray(inner)) return inner.length;
  }
  return 0;
}

serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { data: acctRows, error: acctErr } = await supabase
      .schema("fni")
      .from("store_provider_accounts")
      .select("*")
      .eq("active", true);

    if (acctErr) throw new Error(`Failed to fetch store mappings: ${acctErr.message}`);

    const accounts = (acctRows ?? []) as unknown as StoreProviderAccount[];
    if (accounts.length === 0) {
      return json(200, { message: "No active store mappings configured", refreshed: 0, failed: 0, results: [] });
    }

    // Group by credential so each login happens once and every store under it
    // rides the same session.
    const byCredential = new Map<string, StoreProviderAccount[]>();
    for (const acct of accounts) {
      const list = byCredential.get(acct.credential_id) ?? [];
      list.push(acct);
      byCredential.set(acct.credential_id, list);
    }

    const results: Record<string, unknown>[] = [];

    for (const [credentialId, group] of byCredential) {
      const { data: cred, error: credErr } = await supabase
        .schema("fni")
        .from("provider_credentials")
        .select("*")
        .eq("id", credentialId)
        .eq("active", true)
        .maybeSingle();

      if (credErr || !cred) {
        // The mappings are fine; the account behind them is gone or retired.
        // Say which, because the fix is on the credential and not on any store.
        const why = credErr
          ? `Failed to read credential: ${credErr.message}`
          : "Credential is missing or inactive";
        for (const acct of group) {
          results.push({ store_id: acct.store_id, dealer_code: acct.dealer_code, status: "Failed", error: why });
        }
        continue;
      }

      const credentials = cred as unknown as TecAssuredCredentials;

      for (const acct of group) {
        try {
          // One client per store so each carries its own Dealer ID; the shared
          // session behind them is what makes this one login and not N.
          const client = clientFor(credentials, supabase, acct.dealer_code);
          const vehicleTypes = await client.getVehicleTypes();

          const { error: updateErr } = await supabase
            .schema("fni")
            .from("store_provider_accounts")
            .update({
              vehicle_types_cache: vehicleTypes,
              vehicle_types_cached_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", acct.id);

          if (updateErr) {
            console.error(`Cache write failed for store ${acct.store_id}: ${updateErr.message}`);
            results.push({
              store_id: acct.store_id,
              dealer_code: acct.dealer_code,
              status: "Cache write failed",
              error: updateErr.message,
            });
            continue;
          }

          results.push({
            store_id: acct.store_id,
            dealer_code: acct.dealer_code,
            status: "Refreshed",
            type_count: countTypes(vehicleTypes),
          });
        } catch (err) {
          if (err instanceof EndpointNotFoundError) {
            // Not a failure of this store, this Dealer ID or this login: the
            // endpoint is not on the server at all. Reported once per store so
            // the shape of the sweep is still visible, but as "Unavailable" so
            // nobody goes looking for a fault that is not there.
            results.push({
              store_id: acct.store_id,
              dealer_code: acct.dealer_code,
              status: "Unavailable",
              error: `${err.url} does not exist on this server. Needs the correct endpoint from the Shop API documentation.`,
            });
            continue;
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Vehicle type refresh failed for store ${acct.store_id}: ${message}`);
          results.push({
            store_id: acct.store_id,
            dealer_code: acct.dealer_code,
            status: "Failed",
            error: message,
          });
        }
      }
    }

    const refreshed = results.filter((r) => r.status === "Refreshed").length;
    const unavailable = results.filter((r) => r.status === "Unavailable").length;
    const failed = results.length - refreshed - unavailable;

    return json(200, {
      message:
        `Vehicle types refresh: ${refreshed} refreshed, ${failed} failed` +
        (unavailable > 0 ? `, ${unavailable} unavailable (endpoint not on this server)` : ""),
      logins_used: byCredential.size,
      refreshed,
      failed,
      unavailable,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Vehicle types refresh error:", message);
    return json(500, { error: message });
  }
});
