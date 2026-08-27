import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getRecord } from "../../lib/zoho/client.js";
import { mapDeal } from "../../lib/zoho/dealmap.js";
import { isCronRequest, sbSelect, sbUpdate, sbUpsert } from "../../lib/supabase/service.js";

/*
 * Cron worker: drains sync_queue into public.deals.
 *
 * Runs every minute (vercel.json). Auth: Authorization: Bearer CRON_SECRET,
 * which Vercel sets on scheduled invocations automatically.
 *
 * Per run: claim a batch of unprocessed rows, collapse them per zoho_id so a
 * record edited five times in a minute costs one Zoho read, fetch, map, upsert
 * on zoho_id, then mark every queue row for that id processed.
 *
 * Failures increment attempts and leave the row unprocessed for the next run.
 * At MAX_ATTEMPTS the row stops being picked up — it stays in the table with
 * last_error set, rather than being deleted or retried forever.
 */

const MAX_ATTEMPTS = 5;
const BATCH = 50;
// Stop claiming new work with time left to finish the item in flight.
const TIME_BUDGET_MS = 45_000;

interface QueueRow {
  id: number;
  tenant_id: string;
  module: string;
  zoho_id: string;
  attempts: number;
}

// ---------- store resolution ----------

let storeCache: Map<string, string> | null = null;

/** Zoho Store_Location picklist value -> stores.id. */
async function storeMap(): Promise<Map<string, string>> {
  if (storeCache) return storeCache;
  const rows = await sbSelect<{ id: string; zoho_store_location: string | null }>(
    "stores?select=id,zoho_store_location",
  );
  const map = new Map<string, string>();
  for (const s of rows) if (s.zoho_store_location) map.set(s.zoho_store_location, s.id);
  storeCache = map;
  return map;
}

// ---------- queue ----------

async function markProcessed(ids: number[]): Promise<void> {
  await sbUpdate("sync_queue", `id=in.(${ids.join(",")})`, {
    processed_at: new Date().toISOString(),
    last_error: null,
  });
}

async function markFailed(rows: QueueRow[], message: string): Promise<void> {
  // Truncated: a Zoho error body can be large and this column is for triage.
  const last_error = message.slice(0, 2000);
  await Promise.all(
    rows.map((r) =>
      sbUpdate("sync_queue", `id=eq.${r.id}`, { attempts: r.attempts + 1, last_error }),
    ),
  );
}

// ---------- handler ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isCronRequest(req.headers.authorization)) {
    return res.status(401).json({ error: "Bad cron secret" });
  }

  const started = Date.now();
  let synced = 0;
  let missing = 0;
  let failed = 0;

  try {
    const queue = await sbSelect<QueueRow>(
      `sync_queue?processed_at=is.null&attempts=lt.${MAX_ATTEMPTS}` +
        `&select=id,tenant_id,module,zoho_id,attempts&order=received_at.asc&limit=${BATCH}`,
    );

    // Collapse to one unit of work per record; keep every queue row id so they
    // all get marked processed together.
    const byRecord = new Map<string, QueueRow[]>();
    for (const row of queue) {
      const key = `${row.module}:${row.zoho_id}`;
      const group = byRecord.get(key);
      if (group) group.push(row);
      else byRecord.set(key, [row]);
    }

    const stores = await storeMap();

    for (const rows of byRecord.values()) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const head = rows[0];
      const ids = rows.map((r) => r.id);

      try {
        const record = await getRecord(head.module, head.zoho_id);

        if (!record) {
          // Deleted in Zoho between the webhook and now. Nothing to mirror;
          // clearing the row keeps it from retrying five times.
          await markProcessed(ids);
          missing++;
          continue;
        }

        const deal = mapDeal(record, head.tenant_id);
        const storeId = deal.store_location ? stores.get(deal.store_location) ?? null : null;

        await sbUpsert("deals", { ...deal, store_id: storeId }, "zoho_id");
        await markProcessed(ids);
        synced++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`sync/process ${head.module}/${head.zoho_id} failed`, message);
        await markFailed(rows, message);
        failed++;
      }
    }

    return res.status(200).json({
      claimed: queue.length,
      records: byRecord.size,
      synced,
      missing,
      failed,
      ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("sync/process failed", message);
    return res.status(500).json({ error: message, synced, missing, failed });
  }
}
