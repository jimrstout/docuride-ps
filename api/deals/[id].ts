import type { VercelRequest, VercelResponse } from "@vercel/node";
import { updateRecord } from "../../lib/zoho/client.js";
import { PROMOTED_COLUMNS } from "../../lib/zoho/dealmap.js";
import type { AuthedUser } from "../../lib/supabase/service.js";
import { sbInsert, sbSelect, sbUpdate, userFromRequest } from "../../lib/supabase/service.js";

/*
 * Deal read + narrow write-back.
 *
 * GET   /api/deals/:id   -> the mirrored deal
 * PATCH /api/deals/:id   -> body keyed by Zoho field API name, e.g.
 *                           {"Other_Stipulation": ...}
 *
 * Auth: Authorization: Bearer <Supabase user access token>. The caller's
 * profiles row supplies the tenant; a deal in another tenant reads as absent.
 *
 * PATCH is gated on field_ownership: a field is writable here only if it has
 * a row with owner = 'web'. Default ownership is Zoho (CLAUDE.md), so an
 * unlisted field is rejected rather than silently ignored — otherwise the web
 * and Deluge would both write it and the last sync would win.
 */

const MODULE = "DocuRide";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DealRecord {
  id: string;
  tenant_id: string;
  zoho_id: string;
  raw: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------- helpers ----------

/**
 * A tenant user sees only their own tenant's deals; a platform operator, who
 * has no tenant of their own, sees any deal so they can troubleshoot across
 * customers.
 */
async function loadDeal(id: string, user: AuthedUser): Promise<DealRecord | null> {
  const scope = user.isPlatformAdmin ? "" : `&tenant_id=eq.${user.tenantId}`;
  const rows = await sbSelect<DealRecord>(
    `deals?id=eq.${encodeURIComponent(id)}${scope}&select=*`,
  );
  return rows[0] ?? null;
}

async function webWritableFields(tenantId: string): Promise<Set<string>> {
  const rows = await sbSelect<{ zoho_field: string }>(
    `field_ownership?tenant_id=eq.${tenantId}&owner=eq.web&select=zoho_field`,
  );
  return new Set(rows.map((r) => r.zoho_field));
}

// ---------- handler ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await userFromRequest(req.headers.authorization);
  if (!user) return res.status(401).json({ error: "Sign in required" });

  const id = typeof req.query.id === "string" ? req.query.id : "";
  // Validated before it reaches PostgREST: a non-uuid would come back as a
  // 400 from the database and surface here as an opaque 500.
  if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid deal id" });

  try {
    const deal = await loadDeal(id, user);
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    if (req.method === "GET") return res.status(200).json(deal);
    if (req.method !== "PATCH") return res.status(405).json({ error: "GET or PATCH only" });

    const patch = (req.body ?? {}) as Record<string, unknown>;
    const fields = Object.keys(patch);
    if (fields.length === 0) return res.status(400).json({ error: "Empty patch" });

    // Keyed on the deal's tenant, not the caller's: ownership is a property of
    // the tenant whose record is being written, and a platform operator has no
    // tenant of their own to look it up under.
    const writable = await webWritableFields(deal.tenant_id);
    const rejected = fields.filter((f) => !writable.has(f));
    if (rejected.length > 0) {
      return res.status(403).json({
        error: "Field not web-owned",
        rejected,
        writable: [...writable],
      });
    }

    // 1. Supabase first, so the UI reads its own write even if Zoho is slow.
    //    `raw` is read-modify-written because PostgREST cannot merge jsonb in
    //    place; the row was already fetched above for the tenant check.
    const mergedRaw = { ...deal.raw, ...patch };
    const columnUpdates: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
      const column = PROMOTED_COLUMNS[field];
      if (column) columnUpdates[column] = value;
    }
    await sbUpdate("deals", `id=eq.${encodeURIComponent(deal.id)}`, {
      ...columnUpdates,
      raw: mergedRaw,
    });

    // 2. Then Zoho. If this throws, Supabase is ahead of Zoho — the failure is
    //    recorded below and the next webhook echo re-syncs from Zoho, which
    //    overwrites the optimistic local value rather than leaving it stranded.
    let response: unknown;
    let failure: string | null = null;
    try {
      response = await updateRecord(MODULE, deal.zoho_id, patch);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    // 3. Audit either way — a write that failed at Zoho is the one you most
    //    want a record of.
    await sbInsert("sync_outbound", {
      deal_id: deal.id,
      zoho_id: deal.zoho_id,
      payload: patch,
      zoho_response: failure ? { error: failure } : (response ?? null),
    });

    if (failure) {
      console.error(`deals/${deal.id} zoho write failed`, failure);
      return res.status(502).json({ error: "Zoho update failed", detail: failure });
    }

    return res.status(200).json({ id: deal.id, zoho_id: deal.zoho_id, updated: fields });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`deals/${id} request failed`, message);
    return res.status(500).json({ error: message });
  }
}
