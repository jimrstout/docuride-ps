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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = typeof req.query.secret === "string" ? req.query.secret : undefined;
  if (!secretsMatch(secret, process.env.ZOHO_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: "Bad secret" });
  }

  // Zoho sends Form-Data; Vercel parses it into req.body for us.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const module = typeof body.module === "string" ? body.module.trim() : "";

  if (!id) return res.status(400).json({ error: "Missing id" });
  if (!MODULES.has(module)) return res.status(400).json({ error: `Unsupported module: ${module}` });

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
