import { getRecord } from "../_shared/zoho.ts";
import { mapDeal } from "../_shared/dealmap.ts";
import {
  sbInsert,
  sbSelect,
  sbUpdate,
  sbUpsert,
  secretsMatch,
  zohoTenantId,
} from "../_shared/supabase.ts";

/*
 * Zoho -> Supabase mirror. Webhook and worker in one function.
 *
 * Webhook   POST functions/v1/zoho-sync?secret=<ZOHO_WEBHOOK_SECRET>
 *           params id + module, from the query string or the form body.
 *           Enqueues, then drains inline so a single edit mirrors immediately.
 *
 * Sweeper   POST functions/v1/zoho-sync?mode=drain
 *           header x-webhook-secret: <ZOHO_WEBHOOK_SECRET>
 *           Drains only. Driven by pg_cron every 5 minutes, to pick up rows a
 *           webhook enqueued but could not finish, and rows whose Zoho read
 *           failed and are owed a retry.
 *
 * verify_jwt is false (supabase/config.toml): Zoho cannot send a Supabase JWT,
 * so the shared secret is the whole of the authentication.
 */

const MODULES = new Set(["DocuRide"]);
// Zoho's workflow webhook UI drops literal custom parameters inconsistently
// (observed 2026-08-28: only `secret` and `id` arrive). Since this endpoint
// only serves the DocuRide module today, default it rather than require Zoho
// to transmit it. Revisit when a second module is mirrored.
const DEFAULT_MODULE = "DocuRide";
const MAX_ATTEMPTS = 5;
const BATCH = 50;
// Leave room inside the Edge Function wall clock to finish the item in flight.
const TIME_BUDGET_MS = 50_000;

interface QueueRow {
  id: number;
  tenant_id: string;
  module: string;
  zoho_id: string;
  attempts: number;
}

// ---------- request parsing ----------

/**
 * Zoho's "Form-Data" webhook does not deliver parameters consistently: they
 * arrive url-encoded in the body, as multipart, as JSON, or appended to the
 * query string alongside ?secret=. Production showed
 * `application/x-www-form-urlencoded;charset=UTF-8` with id in the body, but
 * the rule can be reconfigured, so accept all of them. Query wins over body.
 */
async function params(req: Request, url: URL): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) out[k] = v;

  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (ct.includes("form-data") || ct.includes("x-www-form-urlencoded")) {
      for (const [k, v] of await req.formData()) {
        if (typeof v === "string" && !(k in out)) out[k] = v;
      }
    } else {
      const raw = (await req.text()).trim();
      if (raw.startsWith("{")) {
        for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
          if (typeof v === "string" && !(k in out)) out[k] = v;
        }
      } else if (raw.includes("=")) {
        for (const [k, v] of new URLSearchParams(raw)) if (!(k in out)) out[k] = v;
      }
    }
  } catch (e) {
    console.warn("zoho-sync body parse failed", String(e));
  }
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- queue ----------

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

function markProcessed(ids: number[]): Promise<unknown[]> {
  return sbUpdate("sync_queue", `id=in.(${ids.join(",")})`, {
    processed_at: new Date().toISOString(),
    last_error: null,
  });
}

function markFailed(rows: QueueRow[], message: string): Promise<unknown[][]> {
  // Truncated: a Zoho error body can be large and this column is for triage.
  const last_error = message.slice(0, 2000);
  return Promise.all(
    rows.map((r) => sbUpdate("sync_queue", `id=eq.${r.id}`, {
      attempts: r.attempts + 1,
      last_error,
    })),
  );
}

interface DrainResult {
  claimed: number;
  records: number;
  synced: number;
  missing: number;
  failed: number;
}

/**
 * Claim a batch of unprocessed rows and mirror them.
 *
 * Rows are collapsed per zoho_id first: a workflow that fires on every field
 * edit can enqueue one record many times a minute, and that should cost one
 * Zoho read, not one per row. Every queue row in the group is then marked
 * together.
 *
 * A failure increments attempts and leaves the row unprocessed for the next
 * sweep. At MAX_ATTEMPTS it stops being claimed and stays put with last_error
 * set, rather than being deleted or retried forever.
 */
async function drain(started: number): Promise<DrainResult> {
  const queue = await sbSelect<QueueRow>(
    `sync_queue?processed_at=is.null&attempts=lt.${MAX_ATTEMPTS}` +
      `&select=id,tenant_id,module,zoho_id,attempts&order=received_at.asc&limit=${BATCH}`,
  );

  const byRecord = new Map<string, QueueRow[]>();
  for (const row of queue) {
    const key = `${row.module}:${row.zoho_id}`;
    const group = byRecord.get(key);
    if (group) group.push(row);
    else byRecord.set(key, [row]);
  }

  let synced = 0;
  let missing = 0;
  let failed = 0;

  if (byRecord.size > 0) {
    const stores = await storeMap();

    for (const rows of byRecord.values()) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const head = rows[0];
      const ids = rows.map((r) => r.id);

      try {
        const record = await getRecord(head.module, head.zoho_id);

        if (!record) {
          // Deleted in Zoho between the webhook and now. Nothing to mirror;
          // clearing the row stops it burning five attempts.
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
        console.error(`zoho-sync ${head.module}/${head.zoho_id} failed`, message);
        await markFailed(rows, message);
        failed++;
      }
    }
  }

  return { claimed: queue.length, records: byRecord.size, synced, missing, failed };
}

// ---------- handler ----------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const started = Date.now();
  const url = new URL(req.url);

  // Query for Zoho (its webhook builder sets the URL, not headers); header for
  // the pg_cron sweeper, so the secret stays out of request logs.
  const presented = url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
  const configured = Deno.env.get("ZOHO_WEBHOOK_SECRET");
  if (!secretsMatch(presented, configured)) {
    // Lengths and presence only, never the values themselves. This is enough
    // to tell "secret not set" from "secrets differ" from the usual culprit,
    // a trailing newline picked up when pasting into the secrets UI.
    console.warn("zoho-sync auth failed", {
      configuredSet: configured !== undefined,
      configuredLength: configured?.length ?? 0,
      presentedVia: url.searchParams.get("secret")
        ? "query"
        : req.headers.get("x-webhook-secret")
        ? "header"
        : "none",
      presentedLength: presented?.length ?? 0,
    });
    return json(401, { error: "Bad secret" });
  }

  const drainOnly = url.searchParams.get("mode") === "drain";
  let queued: string | null = null;

  try {
    if (!drainOnly) {
      const p = await params(req, url);
      const id = (p.id ?? "").trim();
      const module = (p.module ?? "").trim() || DEFAULT_MODULE;

      if (!id || !MODULES.has(module)) {
        // Key names only, never values: the query string carries the secret.
        console.warn("zoho-sync rejected", {
          contentType: req.headers.get("content-type"),
          keys: Object.keys(p),
          haveId: Boolean(id),
          module: module || null,
        });
        return json(400, { error: !id ? "Missing id" : `Unsupported module: ${module}` });
      }

      await sbInsert("sync_queue", {
        tenant_id: await zohoTenantId(),
        module,
        zoho_id: id,
      });
      queued = id;
    }

    const result = await drain(started);
    return json(200, { queued, ...result, ms: Date.now() - started });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("zoho-sync failed", message);
    // 500 so Zoho retries — a dropped webhook is a deal that never mirrors.
    return json(500, { error: message, queued });
  }
});
