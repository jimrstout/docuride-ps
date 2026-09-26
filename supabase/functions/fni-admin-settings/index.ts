// fni-admin-settings/index.ts
//
// The settings the internal console can edit: the dealer group's customer-facing
// name, and the copy templates that use it.
//
// Input:
//   GET                          -> current settings, plus which templates exist
//   POST { dealer_group_display_name?, templates? }
//
// Auth: FNI_WEBHOOK_SECRET via x-webhook-secret header or ?secret= query param,
// exactly as fni-admin-sessions. The browser never holds it; the console's
// server layer does, and the console's sign-in gates who reaches that layer.
//
// ── Why an Edge Function for two text fields ────────────────────────────
// Because everything else goes this way. anon and authenticated have zero table
// grants in fni, the service-role key is never handed to Vercel, and a settings
// form is not a good reason to open a second path into the database.
//
// ── Clearing a template is how you revert it ────────────────────────────
// Saving a blank body deletes the tenant's row, so the platform default applies
// again. That is the only "reset" anyone needs, and it means the default is
// never edited by accident -- a tenant's change is always a row of its own.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import {
  ALLOWED_PLACEHOLDERS,
  TEMPLATE_KEYS,
  renderTemplate,
  validateTemplate,
} from "../_shared/copy-templates.ts";

/**
 * A sample deductible for the preview only.
 *
 * The real figure comes off the chosen rate, which is the whole reason the
 * amount is a placeholder. This exists so an operator editing the sentence can
 * read it as a customer would before saving it.
 */
const PREVIEW_VALUES: Record<string, Record<string, string>> = {
  [TEMPLATE_KEYS.disappearingDeductible]: { deductible_amount: "$100" },
};

/** Templates the console is allowed to edit. A key not listed is not writable
 *  here, so a typo in a request cannot create a row nothing reads. */
const EDITABLE_KEYS: string[] = [TEMPLATE_KEYS.disappearingDeductible];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

function authorized(req: Request, url: URL): boolean {
  const presented =
    url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
  return secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"));
}

/** Trimmed, or null. An empty box and an absent field mean the same thing. */
function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

/**
 * The one tenant this deployment serves.
 *
 * Same contract as zohoTenantId() in _shared/supabase.ts: exactly one tenant
 * with crm_sync='zoho', and anything else is a misconfiguration worth failing
 * on rather than guessing past.
 */
async function theTenant(supabase: SupabaseClient): Promise<{ id: string; name: string; dealer_group_display_name: string | null }> {
  const { data, error } = await supabase
    .from("tenants")
    .select("id, name, dealer_group_display_name")
    .eq("crm_sync", "zoho");

  if (error) throw new Error(`Failed to read tenants: ${error.message}`);
  const rows = (data ?? []) as { id: string; name: string; dealer_group_display_name: string | null }[];
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one tenant with crm_sync='zoho', found ${rows.length}.`);
  }
  return rows[0];
}

async function readSettings(supabase: SupabaseClient) {
  const tenant = await theTenant(supabase);

  const { data: rows, error } = await supabase
    .schema("fni")
    .from("copy_templates")
    .select("tenant_id, template_key, body")
    .in("template_key", EDITABLE_KEYS);

  if (error) throw new Error(`Failed to read copy templates: ${error.message}`);

  const all = (rows ?? []) as { tenant_id: string | null; template_key: string; body: string }[];

  const templates = EDITABLE_KEYS.map((key) => {
    const own = all.find((r) => r.template_key === key && r.tenant_id === tenant.id);
    const fallback = all.find((r) => r.template_key === key && r.tenant_id === null);
    return {
      template_key: key,
      // What is actually in force.
      body: own?.body ?? fallback?.body ?? null,
      // Whether that is this tenant's own wording or the platform's.
      source: own ? "Tenant" : fallback ? "Platform default" : "Not set",
      // So the console can offer "clear to revert" honestly.
      platform_default: fallback?.body ?? null,
      allowed_placeholders: ALLOWED_PLACEHOLDERS[key] ?? [],
      // What a customer would read, with a sample amount. Null means the
      // sentence would be omitted as things stand, which is usually because no
      // dealer group name has been entered yet.
      preview: renderTemplate(own?.body ?? fallback?.body, {
        ...(PREVIEW_VALUES[key] ?? {}),
        dealer_group_name: tenant.dealer_group_display_name,
      }),
      preview_uses_sample_amount: Boolean(PREVIEW_VALUES[key]),
    };
  });

  return {
    tenant: {
      id: tenant.id,
      // Administrative name, shown so an operator can see which group they are
      // editing. Never customer-facing.
      name: tenant.name,
      dealer_group_display_name: tenant.dealer_group_display_name,
    },
    templates,
  };
}

serve(async (req: Request) => {
  const url = new URL(req.url);

  if (!authorized(req, url)) return json(401, { error: "Unauthorized" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    if (req.method === "GET") {
      return json(200, await readSettings(supabase));
    }

    if (req.method !== "POST") {
      return json(405, { error: "GET or POST only" });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const tenant = await theTenant(supabase);

    // ── The dealer group's customer-facing name ───────────────────────
    // Present-but-blank clears it, which is how an operator undoes a mistake.
    // Cleared means every sentence that needs it is omitted rather than
    // rendered with a gap, so clearing is safe.
    if ("dealer_group_display_name" in body) {
      const name = text(body.dealer_group_display_name);
      if (name !== null && name.length > 120) {
        return json(400, {
          error: "That name is too long for the places it has to fit. 120 characters is the limit.",
        });
      }

      const { error } = await supabase
        .from("tenants")
        .update({ dealer_group_display_name: name })
        .eq("id", tenant.id);

      if (error) return json(500, { error: `Failed to save the name: ${error.message}` });
    }

    // ── Templates ────────────────────────────────────────────────────
    const warnings: string[] = [];

    if (body.templates && typeof body.templates === "object" && !Array.isArray(body.templates)) {
      const now = new Date().toISOString();

      for (const [key, raw] of Object.entries(body.templates as Record<string, unknown>)) {
        if (!EDITABLE_KEYS.includes(key)) {
          return json(400, { error: `${key} is not a template this console edits.` });
        }

        const value = text(raw);

        // Blank reverts to the platform default by removing the override.
        if (value === null) {
          const { error } = await supabase
            .schema("fni")
            .from("copy_templates")
            .delete()
            .eq("template_key", key)
            .eq("tenant_id", tenant.id);
          if (error) return json(500, { error: `Failed to revert ${key}: ${error.message}` });
          continue;
        }

        // A placeholder nobody fills would reach a customer as a literal brace.
        const problems = validateTemplate(key, value);
        if (problems.length > 0) {
          return json(400, {
            error:
              `That wording uses a placeholder this sentence does not have: ` +
              problems.map((p) => `{${p.placeholder}}`).join(", ") + ".",
            allowed_placeholders: ALLOWED_PLACEHOLDERS[key] ?? [],
          });
        }

        // House style for customer-facing copy. Worth saying, not worth
        // refusing a save over.
        if (value.includes("—")) {
          warnings.push(
            "That wording contains an em dash. Customer-facing copy here uses plain English punctuation."
          );
        }

        const { error } = await supabase
          .schema("fni")
          .from("copy_templates")
          .upsert(
            { tenant_id: tenant.id, template_key: key, body: value, updated_at: now },
            { onConflict: "tenant_id,template_key" }
          );

        if (error) return json(500, { error: `Failed to save ${key}: ${error.message}` });
      }
    }

    const settings = await readSettings(supabase);
    return json(200, warnings.length > 0 ? { ...settings, warnings } : settings);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-admin-settings error:", message);
    return json(500, { error: message });
  }
});
