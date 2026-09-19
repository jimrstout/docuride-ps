// fni-acknowledgment/index.ts
//
// Generates the acceptance and decline acknowledgment: the record of what was
// presented and what the customer decided. This is the document that makes a
// self-guided F&I session defensible, and it was entirely absent from the
// reference build.
//
// Input (POST JSON): { session_id }
// Auth: FNI_WEBHOOK_SECRET via x-webhook-secret header or ?secret= query param.
//
// Returns the PDF as base64 plus the line to append to FNI_Signature_Map.
//
// Timing: generated when the customer completes the plan, BEFORE contract
// submit, so that if submit later fails there is still a record of what was
// presented and agreed. Generated even when the customer included nothing -- a
// session where every product was declined is precisely the session most worth
// having a record of.
//
// ── What this deliberately does not do ───────────────────────────────────
// It does not write to Zoho. Two things have to be decided first, and guessing
// either would be worse than returning the pieces and letting the caller place
// them:
//
//   1. Which file upload field receives it. The DocuRide module offers three
//      plausible targets -- External_Form_Upload_1 ("External Bill of Sale Form
//      Upload 1"), External_Form_Upload_2 ("External F-I Form Upload 2") and
//      External_Form_Upload_3. Writing to the wrong one overwrites a document
//      somebody else put there.
//
//   2. FNI_Signature_Map is a textarea with a hard 2000-character limit. An
//      append that crosses it fails the whole Zoho write, so appendSignatureMap
//      in _shared/signature-map.ts does that arithmetic and refuses rather than
//      truncating.
//
// Nothing here changes how the Zoho Sign Deluge function reads the field.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import { secretsMatch } from "../_shared/supabase.ts";
import { SIGNATURE_MAP_LIMIT, appendSignatureMap } from "../_shared/signature-map.ts";
import { getRecord } from "../_shared/zoho.ts";
import { fileUploadValue, updateRecordFields, uploadFile } from "../_shared/zoho-files.ts";
import {
  AckDecision,
  renderAcknowledgment,
} from "../_shared/acknowledgment-pdf.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// "External F-I Form Upload 2" -- the F&I-specific one of the three
// External_Form_Upload fields on the DocuRide module.
const UPLOAD_FIELD = "External_Form_Upload_2";
const SIGNATURE_MAP_FIELD = "FNI_Signature_Map";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function numOr(v: unknown, fallback: number | null = null): number | null {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = new URL(req.url);
  const presented =
    req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
  if (!secretsMatch(presented, Deno.env.get("FNI_WEBHOOK_SECRET"))) {
    return json(401, { error: "Unauthorized" });
  }

  let body: { session_id?: string; deliver?: boolean };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const sessionId = body.session_id;
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return json(400, { error: "A well-formed session_id is required" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { data: session } = await supabase
      .schema("fni").from("sessions").select("*").eq("id", sessionId).maybeSingle();
    if (!session) return json(404, { error: "Session not found" });
    const s = session as Record<string, unknown>;

    // Every product that was presented, not only the ones included.
    const { data: rows } = await supabase
      .schema("fni").from("selected_products").select("*")
      .eq("session_id", sessionId).order("product_name");

    const { data: catRows } = await supabase
      .schema("fni").from("product_catalog")
      .select("product_code, display_name, coverage_duration")
      .eq("tenant_id", s.tenant_id as string);

    const copy = new Map<string, { name: string; duration: string | null }>();
    for (const c of (catRows ?? []) as Record<string, unknown>[]) {
      copy.set(c.product_code as string, {
        name: c.display_name as string,
        duration: (c.coverage_duration as string) ?? null,
      });
    }

    const decisions: AckDecision[] = ((rows ?? []) as Record<string, unknown>[]).map((d) => {
      const code = d.provider_product_id as string;
      const c = copy.get(code);
      return {
        product_code: code,
        product_name: c?.name ?? (d.product_name as string) ?? code,
        disposition: d.disposition as AckDecision["disposition"],
        customer_price: numOr(d.customer_price ?? d.retail_price),
        term_months: (d.term_months as number | null) ?? null,
        coverage_duration: c?.duration ?? null,
      };
    });

    const out = await renderAcknowledgment(
      { PDFDocument, StandardFonts, rgb },
      {
        session_id: String(s.id),
        store_name: "All Seasons Powersports & Equipment",
        buyer_display_name: (s.buyer_display_name as string) ?? null,
        vehicle: [s.unit_year, s.unit_make, s.unit_model].filter(Boolean).join(" "),
        vin: (s.vin as string) ?? null,
        mode: (s.mode as string) ?? null,
        // The lender's principal, not the balance due on the unit.
        principal: numOr(s.tila_amount_financed) ?? numOr(s.amount_financed),
        apr: numOr(s.apr),
        interest_rate: numOr(s.interest_rate),
        term_months: (s.finance_term_total as number | null) ?? null,
        decisions,
      }
    );

    // ── Delivery ────────────────────────────────────────────────────────
    const delivery: Record<string, unknown> = { attempted: false, delivered: false };

    if (body.deliver !== false && s.zoho_deal_id) {
      delivery.attempted = true;
      const zohoId = String(s.zoho_deal_id);
      try {
        const record = await getRecord("DocuRide", zohoId);
        if (!record) throw new Error(`Zoho deal ${zohoId} not found`);

        const existingMap = (record[SIGNATURE_MAP_FIELD] as string | null) ?? null;
        const appended = appendSignatureMap(existingMap, out.signatureMapLine);

        if (!appended.ok) {
          // Abandoned, not truncated. The PDF still comes back in the response,
          // so nothing is lost while somebody sorts the field out.
          delivery.delivered = false;
          delivery.reason = appended.reason;
        } else if (appended.reason) {
          // The line was already there, so this document was already delivered.
          // Uploading again would put a second copy on the record.
          delivery.delivered = true;
          delivery.skipped = true;
          delivery.reason = appended.reason;
        } else {
          const { file_id } = await uploadFile(out.filename, out.bytes);
          await updateRecordFields("DocuRide", zohoId, {
            id: zohoId,
            [UPLOAD_FIELD]: fileUploadValue(file_id),
            [SIGNATURE_MAP_FIELD]: appended.value,
          });
          delivery.delivered = true;
          delivery.file_id = file_id;
          delivery.upload_field = UPLOAD_FIELD;
          delivery.signature_map_length = appended.value.length;
        }
      } catch (err) {
        // A failed delivery must not lose the document. The caller still gets
        // the PDF and can retry, which the dedupe above makes safe.
        delivery.delivered = false;
        delivery.reason = err instanceof Error ? err.message : String(err);
        console.error("fni-acknowledgment delivery failed:", delivery.reason);
      }
    }

    return json(200, {
      session_id: sessionId,
      filename: out.filename,
      pdf_base64: base64(out.bytes),
      signature_map_line: out.signatureMapLine,
      signature_origin: "top-left",
      page: out.page,
      presented_count: decisions.length,
      included_count: decisions.filter((d) => d.disposition === "Included").length,
      totals: out.totals,
      rate_label: out.rateLabel,
      zoho: {
        signature_map_field: SIGNATURE_MAP_FIELD,
        signature_map_limit: SIGNATURE_MAP_LIMIT,
        upload_field: UPLOAD_FIELD,
        ...delivery,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fni-acknowledgment error:", message);
    return json(500, { error: message });
  }
});
