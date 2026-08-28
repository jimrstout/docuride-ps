import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sbInsert, secretsMatch, zohoTenantId } from "../../lib/supabase/service.js";

/*
 * Zoho CRM workflow webhook.
 *
 * Zoho: Setup > Automation > Workflow Rules > DocuRide > on Create or Edit >
 *       Webhook, POST, Form-Data, params: id = DocuRide Id, module = DocuRide
 *       URL: /api/sync/zoho?secret=<ZOHO_WEBHOOK_SECRET>
 *
 * Enqueue only — no Zoho API call, no mapping. Zoho retries a webhook that is
 * slow or non-2xx, and a workflow that fires on every field edit can burst, so
 * this does one insert and returns. api/sync/process.ts does the real work.
 */

const MODULES = new Set(["DocuRide"]);

// ---------- request parsing ----------

/**
 * Zoho's "Form-Data" webhook does not deliver its parameters consistently:
 * depending on how the rule is configured they arrive url-encoded in the body,
 * as JSON, or appended to the query string alongside ?secret=. Vercel also
 * leaves the body as a raw string or Buffer for content types it does not
 * recognise. Normalise all of it rather than trusting one shape — the first
 * production webhook returned 400 because only req.body was read.
 */
function bodyParams(req: VercelRequest): Record<string, unknown> {
  const raw = req.body;
  if (!raw) return {};
  if (Buffer.isBuffer(raw)) return parseRaw(raw.toString("utf8"));
  if (typeof raw === "string") return parseRaw(raw);
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function parseRaw(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(trimmed));
}

/** Query string first, then body. Blank counts as absent. */
function param(name: string, query: Record<string, unknown>, body: Record<string, unknown>): string {
  for (const source of [query, body]) {
    const v = source[name];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const query = (req.query ?? {}) as Record<string, unknown>;

  const secret = typeof query.secret === "string" ? query.secret : undefined;
  if (!secretsMatch(secret, process.env.ZOHO_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: "Bad secret" });
  }

  const body = bodyParams(req);
  const id = param("id", query, body);
  const module = param("module", query, body);

  if (!id || !MODULES.has(module)) {
    // Key names only, never values: the query string carries the secret.
    console.warn("sync/zoho rejected", {
      contentType: req.headers["content-type"] ?? null,
      queryKeys: Object.keys(query),
      bodyKeys: Object.keys(body),
      haveId: Boolean(id),
      module: module || null,
    });
    return res
      .status(400)
      .json({ error: !id ? "Missing id" : `Unsupported module: ${module}` });
  }

  try {
    const tenantId = await zohoTenantId();
    await sbInsert("sync_queue", { tenant_id: tenantId, module, zoho_id: id });
    return res.status(200).json({ queued: id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("sync/zoho enqueue failed", message);
    // 500 so Zoho retries — a dropped webhook is a deal that never mirrors.
    return res.status(500).json({ error: message });
  }
}
