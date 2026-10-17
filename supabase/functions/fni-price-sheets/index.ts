// fni-price-sheets/index.ts
//
// The admin area's price sheets: list, open, upload, correct a rate, leave a
// rate out, publish, retire. See docs/multi-provider.md, section 6.
//
// Auth: FNI_WEBHOOK_SECRET in the x-webhook-secret header. Only the admin
// area's server calls this, after its operator sign-in, and it names the
// operator on every write. Reading the file with Claude is fni-price-sheet-parse.
//
// Nothing here deletes anything. A misread rate is left out with a reason; a
// replaced sheet is retired, not removed.
//
// GET  ?provider_id=...          sheets for one provider (or every provider)
// GET  ?sheet_id=...             one sheet with its rates
// POST { action: "upload_url", provider_id, file_name }
//        a one-time signed URL the browser uploads the file to directly, so a
//        large sheet never passes through the admin area's server
// POST { action: "upload", provider_id, name, effective_from, effective_to,
//        file_name, file_path | file_base64, uploaded_by }
// POST { action: "edit_rate", rate_id, edited_by, ...fields }
// POST { action: "leave_out", rate_id, reason, edited_by }
// POST { action: "include", rate_id, edited_by }
// POST { action: "publish", sheet_id, published_by }
// POST { action: "retire", sheet_id, reason, retired_by }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/supabase.ts";
import { BUCKET, fileTypeFor, parseRateEdit, parseUpload, safeFileName } from "../_shared/price-sheet-admin.ts";
import { checkRates, datesOverlap, publishRefusal, type CheckedRate } from "../_shared/price-sheet-checks.ts";
import { newCatalogRows, type SheetProduct } from "../_shared/oem-contracts.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SHEET_COLUMNS =
  "id, provider_id, name, effective_from, effective_to, status, file_name, file_type, " +
  "parse_status, parse_notes, model, input_tokens, output_tokens, parse_seconds, parsed_at, " +
  "uploaded_by, uploaded_at, published_by, published_at, retired_at, retired_reason, updated_at";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function loadSheet(supabase: SupabaseClient, id: string) {
  const { data } = await supabase.schema("fni").from("price_sheets").select(SHEET_COLUMNS).eq("id", id).maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

async function loadRates(supabase: SupabaseClient, sheetId: string) {
  const { data, error } = await supabase
    .schema("fni")
    .from("price_sheet_rates")
    .select("*")
    .eq("sheet_id", sheetId)
    .order("product_code")
    .order("term_months")
    .order("deductible");
  if (error) throw new Error(`Failed to read the rates: ${error.message}`);
  return (data ?? []) as Record<string, unknown>[];
}

/** Postgres numerics arrive as strings; the checks read numbers. */
function asChecked(r: Record<string, unknown>): CheckedRate & { id: string } {
  const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    ...(r as unknown as CheckedRate),
    id: r.id as string,
    deductible: n(r.deductible),
    dealer_cost: n(r.dealer_cost),
    suggested_retail: n(r.suggested_retail),
  };
}

/** Run the checks again over the sheet's rates, after a correction. */
async function recheck(supabase: SupabaseClient, sheetId: string): Promise<void> {
  const rows = (await loadRates(supabase, sheetId)).filter((r) => r.left_out !== true).map(asChecked);
  const fresh = checkRates(rows.map((r) => ({ ...r, flagged: false, flag_reason: null })));
  for (let i = 0; i < fresh.length; i++) {
    if (fresh[i].flagged === rows[i].flagged && fresh[i].flag_reason === rows[i].flag_reason) continue;
    await supabase
      .schema("fni")
      .from("price_sheet_rates")
      .update({ flagged: fresh[i].flagged, flag_reason: fresh[i].flag_reason })
      .eq("id", rows[i].id);
  }
}

type DraftRate =
  | { error: Response }
  | { error: null; rate: { id: string; sheet_id: string }; sheet: Record<string, unknown> };

/** The rate and its sheet, refusing anything but a Draft. */
async function draftRate(supabase: SupabaseClient, rateId: unknown): Promise<DraftRate> {
  if (typeof rateId !== "string" || !UUID_RE.test(rateId)) return { error: json(400, { error: "Which rate is missing." }) };
  const { data: rate } = await supabase.schema("fni").from("price_sheet_rates").select("id, sheet_id").eq("id", rateId).maybeSingle();
  if (!rate) return { error: json(404, { error: "That rate no longer exists." }) };
  const sheet = await loadSheet(supabase, (rate as { sheet_id: string }).sheet_id);
  if (!sheet || sheet.status !== "Draft") {
    return { error: json(409, { error: "Only a Draft sheet's rates can be changed. Upload a new sheet to change a published one." }) };
  }
  return { error: null, rate: rate as { id: string; sheet_id: string }, sheet };
}

async function upload(supabase: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const parsed = parseUpload(body);
  if ("errors" in parsed) return json(400, { error: parsed.errors.join(" "), errors: parsed.errors });
  const f = parsed.fields;

  const { data: provider } = await supabase
    .schema("fni")
    .from("providers")
    .select("id, tenant_id, name, kind")
    .eq("id", f.provider_id)
    .maybeSingle();
  const p = provider as { id: string; tenant_id: string; name: string; kind: string } | null;
  if (!p) return json(404, { error: "That provider does not exist." });
  if (p.kind !== "Price Sheet") {
    return json(400, { error: `${p.name} is rated through its API, so it has no price sheets.` });
  }

  let id: string;
  let path: string;
  if (f.file_path) {
    // Already in the bucket: the browser uploaded it to a signed URL. It must
    // actually be there before a sheet points at it.
    path = f.file_path;
    id = path.split("/")[1];
    const folder = path.split("/").slice(0, 2).join("/");
    const { data: found } = await supabase.storage.from(BUCKET).list(folder, { search: path.split("/")[2] });
    if (!found || found.length === 0) return json(400, { error: "The uploaded file could not be found. Upload it again." });
  } else {
    id = crypto.randomUUID();
    path = `${p.id}/${id}/${safeFileName(f.file_name)}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, f.bytes!, { contentType: f.mime, upsert: false });
    if (upErr) return json(502, { error: `The file could not be stored: ${upErr.message}` });
  }

  const { error } = await supabase.schema("fni").from("price_sheets").insert({
    id,
    tenant_id: p.tenant_id,
    provider_id: p.id,
    name: f.name,
    effective_from: f.effective_from,
    effective_to: f.effective_to,
    status: "Draft",
    file_path: path,
    file_name: f.file_name,
    file_type: f.file_type,
    parse_status: "Not Parsed",
    uploaded_by: f.uploaded_by,
  });
  if (error) return json(500, { error: `The sheet could not be saved: ${error.message}` });
  return json(200, { sheet: await loadSheet(supabase, id) });
}

/** A one-time URL the browser uploads one file to, straight into the bucket. */
async function uploadUrl(supabase: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const providerId = text(body.provider_id);
  const fileName = text(body.file_name);
  if (!UUID_RE.test(providerId)) return json(400, { error: "Choose the provider this sheet is from." });
  if (!fileTypeFor(fileName)) return json(400, { error: "The file must be a PDF, an Excel workbook (XLSX or XLS) or a CSV." });
  const { data: provider } = await supabase.schema("fni").from("providers").select("id, name, kind").eq("id", providerId).maybeSingle();
  const p = provider as { id: string; name: string; kind: string } | null;
  if (!p) return json(404, { error: "That provider does not exist." });
  if (p.kind !== "Price Sheet") return json(400, { error: `${p.name} is rated through its API, so it has no price sheets.` });

  const path = `${p.id}/${crypto.randomUUID()}/${safeFileName(fileName)}`;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) return json(502, { error: `An upload could not be started: ${error?.message ?? "no URL"}` });
  return json(200, { file_path: path, signed_url: data.signedUrl });
}

async function publish(supabase: SupabaseClient, body: Record<string, unknown>): Promise<Response> {
  const by = text(body.published_by);
  if (by === "") return json(400, { error: "Who is publishing is missing." });
  if (typeof body.sheet_id !== "string" || !UUID_RE.test(body.sheet_id)) return json(400, { error: "Which sheet is missing." });
  const sheet = await loadSheet(supabase, body.sheet_id);
  if (!sheet) return json(404, { error: "That sheet no longer exists." });
  const rates = await loadRates(supabase, sheet.id as string);
  const refusal = publishRefusal(
    sheet as never,
    rates.map((r) => ({ flagged: r.flagged === true, left_out: r.left_out === true }))
  );
  if (refusal) return json(409, { error: refusal });

  // The provider's Published sheets whose dates overlap this one are retired:
  // there is one sheet in force for a provider on any day.
  const { data: others } = await supabase
    .schema("fni")
    .from("price_sheets")
    .select("id, name, effective_from, effective_to")
    .eq("provider_id", sheet.provider_id as string)
    .eq("status", "Published");
  const now = new Date().toISOString();
  const retired: string[] = [];
  for (const o of (others ?? []) as { id: string; name: string; effective_from: string; effective_to: string | null }[]) {
    if (!datesOverlap(o, sheet as never)) continue;
    await supabase
      .schema("fni")
      .from("price_sheets")
      .update({
        status: "Retired",
        retired_at: now,
        retired_reason: `Replaced by "${sheet.name}", published by ${by}.`,
        updated_at: now,
      })
      .eq("id", o.id);
    retired.push(o.name);
  }

  const { error } = await supabase
    .schema("fni")
    .from("price_sheets")
    .update({ status: "Published", published_by: by, published_at: now, updated_at: now })
    .eq("id", sheet.id as string);
  if (error) return json(500, { error: `The sheet could not be published: ${error.message}` });
  const catalog = await addToCatalog(supabase, sheet, rates);
  return json(200, { sheet: await loadSheet(supabase, sheet.id as string), retired, catalog });
}

/**
 * Every product the published sheet offers gets a catalog row, so Menus can
 * put it in a slot and the planner can find it. Name and category only: no
 * customer wording is written for it, so it is not presentable until staff
 * write it under Providers, Product wording. A failure here does not undo the
 * publish; it is said, and publishing again adds what is missing.
 */
async function addToCatalog(
  supabase: SupabaseClient,
  sheet: Record<string, unknown>,
  rates: Record<string, unknown>[]
): Promise<{ added: string[]; problem: string | null }> {
  const { data: existing, error: readErr } = await supabase
    .schema("fni")
    .from("product_catalog")
    .select("product_code")
    .eq("tenant_id", sheet.tenant_id as string)
    .eq("provider_id", sheet.provider_id as string)
    .is("store_id", null);
  if (readErr) return { added: [], problem: `The catalog could not be read: ${readErr.message}` };
  const rows = newCatalogRows(
    rates as unknown as SheetProduct[],
    new Set(((existing ?? []) as { product_code: string }[]).map((r) => r.product_code)),
    sheet.tenant_id as string,
    sheet.provider_id as string
  );
  if (rows.length === 0) return { added: [], problem: null };
  const { error } = await supabase.schema("fni").from("product_catalog").insert(rows);
  if (error) return { added: [], problem: `The sheet's products could not be added to the catalog: ${error.message}` };
  return { added: rows.map((r) => r.display_name as string), problem: null };
}

serve(async (req: Request) => {
  if (!secretsMatch(req.headers.get("x-webhook-secret"), Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const sheetId = url.searchParams.get("sheet_id");
      if (sheetId) {
        if (!UUID_RE.test(sheetId)) return json(400, { error: "That is not a sheet." });
        const sheet = await loadSheet(supabase, sheetId);
        if (!sheet) return json(404, { error: "That sheet no longer exists." });
        return json(200, { sheet, rates: await loadRates(supabase, sheetId) });
      }
      let q = supabase.schema("fni").from("price_sheets").select(SHEET_COLUMNS).order("uploaded_at", { ascending: false });
      const providerId = url.searchParams.get("provider_id");
      if (providerId) q = q.eq("provider_id", providerId);
      const { data, error } = await q;
      if (error) return json(500, { error: error.message });
      return json(200, { sheets: data ?? [] });
    }

    if (req.method !== "POST") return json(405, { error: "GET or POST only" });
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    switch (body.action) {
      case "upload_url":
        return await uploadUrl(supabase, body);

      case "upload":
        return await upload(supabase, body);

      case "edit_rate": {
        const by = text(body.edited_by);
        if (by === "") return json(400, { error: "Who is making the change is missing." });
        const found = await draftRate(supabase, body.rate_id);
        if (found.error) return found.error;
        const { action: _a, rate_id: _r, edited_by: _e, ...fields } = body;
        const parsed = parseRateEdit(fields);
        if ("errors" in parsed) return json(400, { error: parsed.errors.join(" "), errors: parsed.errors });
        const { error } = await supabase
          .schema("fni")
          .from("price_sheet_rates")
          .update({ ...parsed.patch, edited_by: by, edited_at: new Date().toISOString() })
          .eq("id", found.rate.id);
        if (error) return json(500, { error: error.message });
        await recheck(supabase, found.rate.sheet_id);
        return json(200, { rates: await loadRates(supabase, found.rate.sheet_id) });
      }

      case "leave_out":
      case "include": {
        const by = text(body.edited_by);
        if (by === "") return json(400, { error: "Who is making the change is missing." });
        const found = await draftRate(supabase, body.rate_id);
        if (found.error) return found.error;
        const leave = body.action === "leave_out";
        const reason = text(body.reason);
        if (leave && reason === "") return json(400, { error: "Say why the rate is left out." });
        const { error } = await supabase
          .schema("fni")
          .from("price_sheet_rates")
          .update({
            left_out: leave,
            left_out_reason: leave ? reason : null,
            edited_by: by,
            edited_at: new Date().toISOString(),
          })
          .eq("id", found.rate.id);
        if (error) return json(500, { error: error.message });
        await recheck(supabase, found.rate.sheet_id);
        return json(200, { rates: await loadRates(supabase, found.rate.sheet_id) });
      }

      case "publish":
        return await publish(supabase, body);

      case "retire": {
        const by = text(body.retired_by);
        const reason = text(body.reason);
        if (by === "" || reason === "") return json(400, { error: "Say who is retiring the sheet, and why." });
        if (typeof body.sheet_id !== "string" || !UUID_RE.test(body.sheet_id)) return json(400, { error: "Which sheet is missing." });
        const sheet = await loadSheet(supabase, body.sheet_id);
        if (!sheet) return json(404, { error: "That sheet no longer exists." });
        if (sheet.status === "Retired") return json(409, { error: `"${sheet.name}" is already retired.` });
        const now = new Date().toISOString();
        const { error } = await supabase
          .schema("fni")
          .from("price_sheets")
          .update({ status: "Retired", retired_at: now, retired_reason: `${reason} (${by})`, updated_at: now })
          .eq("id", sheet.id as string);
        if (error) return json(500, { error: error.message });
        return json(200, { sheet: await loadSheet(supabase, sheet.id as string) });
      }

      default:
        break;
    }
    return json(400, { error: "Unknown action." });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-price-sheets error:", message);
    return json(500, { error: message });
  }
});
