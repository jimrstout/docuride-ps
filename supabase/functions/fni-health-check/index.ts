// fni-health-check/index.ts
//
// Cron job (about every six hours) that answers two questions separately:
//
//   Does the shared login still work?      -> one check per active credential
//   Is each store's Dealer ID still good?  -> one check per active mapping
//
// ── Why they are separate ───────────────────────────────────────────────
// They used to be one check, because credentials were per store: a failure was
// a failure and the remedy was obvious. Under one shared login the two have
// completely different blast radii and completely different fixes. A bad
// password is one row and takes every store down at once. A bad Dealer ID is
// one mapping and takes one store down. A log that says only "Failed" for nine
// stores cannot tell you which of those you are looking at, and that is the
// difference between a five-minute fix and an afternoon.
//
// So api_health_checks now carries check_scope, and a Login row is written
// before any store is touched.
//
// Triggered by pg_cron via HTTP POST with the service role key. No JWT
// verification: the function is called by the scheduler, not by a user.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  TecAssuredCredentials,
  StoreProviderAccount,
  EndpointNotFoundError,
  clientFor,
  resetSessionCache,
} from "../_shared/tecassured.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** "Timeout" is worth telling apart from "Failed": one is the network, the
 *  other is us or them. Both are failures; only one is worth retrying as-is. */
function statusFor(ok: boolean, message: string | null): string {
  if (ok) return "Passed";
  if (message && /timed out|timeout/i.test(message)) return "Timeout";
  return "Failed";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface CheckRow {
  credential_id: string;
  store_id: string | null;
  check_scope: "Login" | "Dealer Code";
  dealer_code: string | null;
  status: string;
  auth_ok: boolean;
  api_ok: boolean;
  response_time_ms: number;
  error_message: string | null;
}

async function log(supabase: SupabaseClient, row: CheckRow): Promise<void> {
  const { error } = await supabase.schema("fni").from("api_health_checks").insert(row);
  if (error) {
    // A health check that cannot record its result is still a health check that
    // ran. Say so loudly and carry on rather than failing the sweep.
    console.error(`Failed to log ${row.check_scope} check: ${error.message}`);
  }
}

serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // A scheduled run should prove the login works, not prove that a session
    // cached twenty minutes ago has not expired yet.
    resetSessionCache();

    const { data: credRows, error: credErr } = await supabase
      .schema("fni")
      .from("provider_credentials")
      .select("*")
      .eq("active", true);

    if (credErr) throw new Error(`Failed to fetch credentials: ${credErr.message}`);

    const credentials = (credRows ?? []) as unknown as TecAssuredCredentials[];
    if (credentials.length === 0) {
      return json(200, { message: "No active credentials configured", logins: 0, stores: 0 });
    }

    const logins: unknown[] = [];
    const stores: unknown[] = [];

    for (const cred of credentials) {
      // ── The login ──────────────────────────────────────────────────────
      const loginStart = Date.now();
      let authOk = false;
      let loginError: string | null = null;

      // No dealer code: proving the account works is a question about the
      // account, and no dealer need be named to ask it.
      const client = clientFor({ ...cred, session_id_cached: null, session_expires_at: null }, supabase);

      try {
        const result = await client.authenticate();
        authOk = !!result.sessionId;
        if (!authOk) loginError = "Authenticated but no session id was returned";
      } catch (err) {
        loginError = errText(err);
      }

      const loginMs = Date.now() - loginStart;

      await log(supabase, {
        credential_id: cred.id,
        // A login belongs to the account, not to any one of its stores.
        store_id: null,
        check_scope: "Login",
        dealer_code: null,
        status: statusFor(authOk, loginError),
        auth_ok: authOk,
        // Nothing dealer-scoped was called at this scope, so this restates
        // auth_ok rather than claiming a call that did not happen.
        api_ok: authOk,
        response_time_ms: loginMs,
        error_message: loginError,
      });

      logins.push({
        credential_id: cred.id,
        username: cred.username,
        environment: cred.environment,
        status: statusFor(authOk, loginError),
        response_time_ms: loginMs,
        error: loginError,
      });

      // ── The stores on it ───────────────────────────────────────────────
      const { data: acctRows, error: acctErr } = await supabase
        .schema("fni")
        .from("store_provider_accounts")
        .select("*")
        .eq("credential_id", cred.id)
        .eq("active", true);

      if (acctErr) {
        console.error(`Failed to list mappings for ${cred.id}: ${acctErr.message}`);
        continue;
      }

      const accounts = (acctRows ?? []) as unknown as StoreProviderAccount[];

      if (!authOk) {
        // Every dealer-code check under a dead login would fail for the login's
        // reason, not its own. Writing nine "Failed" rows that all mean "the
        // password is wrong" is how a log stops being worth reading, so they
        // are reported as skipped and not logged as failures.
        for (const acct of accounts) {
          stores.push({
            store_id: acct.store_id,
            dealer_code: acct.dealer_code,
            status: "Skipped",
            error: "Login failed; dealer code not checked",
          });
        }
        continue;
      }

      for (const acct of accounts) {
        const start = Date.now();
        let apiOk = false;
        let error: string | null = null;
        let typeCount: number | null = null;

        // "Unavailable" is not "Failed". A missing endpoint says nothing about
        // whether this Dealer ID is good, and recording it as a failure would
        // put nine red rows against nine perfectly fine stores. See the note on
        // getVehicleTypes in _shared/tecassured.ts.
        let scopeStatus: string | null = null;

        try {
          const types = await client.getVehicleTypes(acct.dealer_code);
          apiOk = !!types;
          typeCount = countTypes(types);
          if (apiOk && typeCount === 0) {
            // The call worked and the dealer has nothing to sell. That is not a
            // transport failure, but it is not a healthy store either.
            error = "getVehicleTypes returned no vehicle types for this Dealer ID";
          }
        } catch (err) {
          if (err instanceof EndpointNotFoundError) {
            scopeStatus = "Unavailable";
            error =
              `Dealer ID not verified: ${err.url} does not exist on this server. ` +
              `The login is fine. Needs the correct endpoint from the Shop API documentation.`;
          } else {
            error = errText(err);
          }
        }

        const ms = Date.now() - start;

        await log(supabase, {
          credential_id: cred.id,
          store_id: acct.store_id,
          check_scope: "Dealer Code",
          dealer_code: acct.dealer_code,
          status: scopeStatus ?? statusFor(apiOk, error),
          // The login already succeeded, or we would not be here.
          auth_ok: true,
          api_ok: apiOk,
          response_time_ms: ms,
          error_message: error,
        });

        stores.push({
          store_id: acct.store_id,
          dealer_code: acct.dealer_code,
          status: scopeStatus ?? statusFor(apiOk, error),
          vehicle_type_count: typeCount,
          response_time_ms: ms,
          error,
        });
      }
    }

    const loginsPassed = logins.filter((l) => (l as { status: string }).status === "Passed").length;
    const storesPassed = stores.filter((s) => (s as { status: string }).status === "Passed").length;

    return json(200, {
      message:
        `Logins: ${loginsPassed}/${logins.length} passed. ` +
        `Dealer IDs: ${storesPassed}/${stores.length} passed.`,
      logins,
      stores,
    });
  } catch (err) {
    const message = errText(err);
    console.error("fni-health-check error:", message);
    return json(500, { error: message });
  }
});

/** TecAssured has returned both a bare array and a wrapper over one. */
function countTypes(types: unknown): number {
  if (Array.isArray(types)) return types.length;
  if (types && typeof types === "object") {
    const inner = (types as Record<string, unknown>).vehicleTypes;
    if (Array.isArray(inner)) return inner.length;
  }
  return 0;
}
