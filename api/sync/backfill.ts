import type { VercelRequest, VercelResponse } from "@vercel/node";
import { coqlAll } from "../../lib/zoho/client.js";
import { isCronRequest, sbInsert, zohoTenantId } from "../../lib/supabase/service.js";

/*
 * One-shot backfill: enqueue every DocuRide record id.
 *
 * POST /api/sync/backfill   Authorization: Bearer CRON_SECRET
 *
 * Discovery is a paged COQL over ids only — 200 ids per call rather than one
 * API call per record (MIGRATION_PATH.md §8 flags rate limits as the backfill
 * risk). The queue rows then drain through api/sync/process.ts at the cron's
 * pace, which is what keeps the record reads spread out.
 *
 * Safe to re-run: process.ts upserts on zoho_id, so a duplicate enqueue
 * refreshes the row rather than creating a second one.
 */

const MODULE = "DocuRide";
const INSERT_CHUNK = 500;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!isCronRequest(req.headers.authorization)) {
    return res.status(401).json({ error: "Bad cron secret" });
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

    return res.status(200).json({ module: MODULE, queued: rows.length, ms: Date.now() - started });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("sync/backfill failed", message);
    return res.status(500).json({ error: message });
  }
}
