// fni-refresh-vehicle-types/index.ts  —  RETIRED 2026-09-25
//
// This function cached /rate/vehicletypes. That endpoint does not exist on the
// TecAssured Shop API: probed under every spelling and both methods, it returns
// a Tomcat 404 while the other endpoints answer. See
// _shared/TECASSURED_SHOP_API.md.
//
// Its replacement is fni-refresh-rate-properties, which caches
// /rate/requiredproperties per store per vehicle type. That answers the more
// useful question -- what has to be sent in order to rate -- and a vehicle type
// a dealer does not sell comes back empty, which is the same information this
// function was trying to get.
//
// ── Why a tombstone and not a deletion ──────────────────────────────────
// The columns it wrote were dropped by migration 0011, so the old code can only
// fail, and it would fail deep inside a loop with a Postgres error about a
// missing column. Anything still pointing here -- a cron job, a runbook, a
// bookmark -- deserves to be told where the function went instead. It is two
// lines of nothing, and it is safe to delete from the Supabase dashboard once
// nothing calls it.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

serve(() =>
  new Response(
    JSON.stringify({
      error: "fni-refresh-vehicle-types has been retired",
      reason:
        "It cached /rate/vehicletypes, which does not exist on the TecAssured Shop API.",
      replacement: "fni-refresh-rate-properties",
      detail:
        "Caches /rate/requiredproperties per store per vehicle type into " +
        "fni.store_rate_properties. Update any pg_cron job to call it instead.",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } }
  )
);
