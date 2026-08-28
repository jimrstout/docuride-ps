import { coqlAll } from "../_shared/zoho.ts";
import { sbInsert, secretsMatch, zohoTenantId } from "../_shared/supabase.ts";

/*
 * One-shot backfill: enqueue every DocuRide record id.
 *
 * POST functions/v1/zoho-backfill
 * header x-backfill-secret: <BACKFILL_SECRET>
 *
 * Discovery is a paged COQL over ids only — 200 ids per call rather than one
 * API call per record (MIGRATION_PATH.md §8 flags rate limits as the backfill
 * risk). The rows then drain through zoho-sync at the sweeper's pace, which is
 * what keeps the per-record reads spread out.
 *
 * Safe to re-run: zoho-sync upserts on zoho_id, so a duplicate enqueue
 * refreshes the deal rather than creating a second one.
 *
 * Its own secret rather than the webhook's: this one enqueues thousands of
 * rows and is worth being able to rotate on its own. verify_jwt is false so it
 * can be triggered with curl during a migration window.
 */

const MODULE = "DocuRide";
const INSERT_CHUNK = 500;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const presented = req.headers.get("x-backfill-secret");
  if (!secretsMatch(presented, Deno.env.get("BACKFILL_SECRET"))) {
    return json(401, { error: "Bad secret" });
  }

  const started = Date.now();

  try {
    const tenantId = await zohoTenantId();

    // COQL requires a WHERE clause; id is never null, so this selects all.
    // Ordering by id keeps paging stable while records are being edited.
    const rows = await coqlAll<{ id: string }>(
      `SELECT id FROM ${MODULE} WHERE id is not null ORDER BY id asc`,
    );

    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK).map((r) => ({
        tenant_id: tenantId,
        module: MODULE,
        zoho_id: String(r.id),
      }));
      await sbInsert("sync_queue", chunk);
    }

    return json(200, { module: MODULE, queued: rows.length, ms: Date.now() - started });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("zoho-backfill failed", message);
    return json(500, { error: message });
  }
});
