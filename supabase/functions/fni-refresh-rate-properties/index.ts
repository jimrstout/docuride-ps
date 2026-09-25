// fni-refresh-rate-properties/index.ts
//
// Nightly cron job (about 3 AM Eastern) that refreshes, for every store with an
// active Dealer ID, the property list TecAssured needs in order to rate each
// vehicle type DocuRide can produce.
//
// ── What this replaced ──────────────────────────────────────────────────
// fni-refresh-vehicle-types, which cached /rate/vehicletypes. That endpoint
// does not exist -- a Tomcat 404 under every spelling and both methods. This
// caches /rate/requiredproperties instead, which does exist and answers the
// more useful question: not "what does this dealer sell" but "what do I have to
// send to rate it". A vtype the dealer does not sell comes back with nothing
// and is recorded as "Unavailable", which is the same information the missing
// endpoint would have given, arrived at from the side that works.
//
// The old function name is kept deployed as a tombstone that says so.
//
// ── One session for the whole sweep ─────────────────────────────────────
// Stores are grouped by credential, so nine stores on one login authenticate
// once between them rather than nine times.
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
import { RATEABLE_VTYPES } from "../_shared/vehicle-types.ts";
import { writeRateProperties } from "../_shared/rate-properties.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
      return json(200, {
        message: "No active store mappings configured",
        cached: 0,
        unavailable: 0,
        failed: 0,
        results: [],
      });
    }

    // Group by credential so each login happens once.
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
        const why = credErr
          ? `Failed to read credential: ${credErr.message}`
          : "Credential is missing or inactive";
        for (const acct of group) {
          results.push({
            store_id: acct.store_id,
            dealer_code: acct.dealer_code,
            status: "Failed",
            error: why,
          });
        }
        continue;
      }

      const credentials = cred as unknown as TecAssuredCredentials;

      for (const acct of group) {
        // One client per store so each carries its own Dealer ID; the shared
        // session behind them is what makes this one login and not N.
        const client = clientFor(credentials, supabase, acct.dealer_code);

        for (const vtype of RATEABLE_VTYPES) {
          try {
            const response = await client.getRequiredProperties(vtype);
            const parsed = await writeRateProperties(supabase, acct.id, vtype, response);

            results.push({
              store_id: acct.store_id,
              dealer_code: acct.dealer_code,
              vtype,
              // An empty answer is the dealer saying it does not sell this type.
              // Recorded, not treated as a fault.
              status: parsed.names.length > 0 ? "Cached" : "Unavailable",
              property_count: parsed.names.length,
              properties: parsed.names,
            });
          } catch (err) {
            if (err instanceof EndpointNotFoundError) {
              // Would mean requiredproperties has moved too. Distinct from a
              // dealer or vtype problem, so it says so.
              results.push({
                store_id: acct.store_id,
                dealer_code: acct.dealer_code,
                vtype,
                status: "Failed",
                error: `${err.url} does not exist on this server.`,
              });
              continue;
            }
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `Rate properties refresh failed for store ${acct.store_id} ${vtype}: ${message}`
            );
            results.push({
              store_id: acct.store_id,
              dealer_code: acct.dealer_code,
              vtype,
              status: "Failed",
              error: message,
            });
          }
        }
      }
    }

    const cached = results.filter((r) => r.status === "Cached").length;
    const unavailable = results.filter((r) => r.status === "Unavailable").length;
    const failed = results.filter((r) => r.status === "Failed").length;

    return json(200, {
      message:
        `Rate properties refresh: ${cached} cached, ${unavailable} unavailable, ${failed} failed ` +
        `across ${accounts.length} store(s) x ${RATEABLE_VTYPES.length} vehicle type(s)`,
      logins_used: byCredential.size,
      vtypes: RATEABLE_VTYPES,
      cached,
      unavailable,
      failed,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Rate properties refresh error:", message);
    return json(500, { error: message });
  }
});
