// _shared/price-sheet-admin.ts
//
// Checking what staff send about price sheets: an upload, a correction to a
// rate, a rate left out. Pure, so a Node test can hold the rules, and every
// refusal is a sentence a person can act on.

import { CATEGORIES } from "./providers.ts";
import { RATEABLE_VTYPES } from "./vehicle-types.ts";

/** The private Storage bucket price sheets are kept in. */
export const BUCKET = "price-sheets";

/** Twenty megabytes. A price sheet bigger than that is almost always scans. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const TYPES: Record<string, { type: string; mime: string }> = {
  pdf: { type: "PDF", mime: "application/pdf" },
  xlsx: { type: "XLSX", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  xls: { type: "XLS", mime: "application/vnd.ms-excel" },
  csv: { type: "CSV", mime: "text/csv" },
};

/** "PDF", "XLSX", "XLS" or "CSV" from the file's name, or null. */
export function fileTypeFor(name: string): { type: string; mime: string } | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return TYPES[ext] ?? null;
}

/** A name safe for a storage path: letters, digits, dots, dashes. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-+\./g, ".");
  return cleaned.replace(/^[-.]+|[-.]+$/g, "").slice(0, 120) || "price-sheet";
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Where an uploaded file lives: provider id, sheet id, safe file name. A path
 * the browser reports back is held to this shape and to its provider, so it
 * cannot name another provider's file or anything outside the bucket's layout.
 */
export const UPLOADED_PATH = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/([A-Za-z0-9._-]{1,120})$/i;

export interface UploadFields {
  provider_id: string;
  name: string;
  effective_from: string;
  effective_to: string | null;
  file_name: string;
  file_type: string;
  mime: string;
  /** The file itself, when it came in the request. */
  bytes: Uint8Array | null;
  /** Where the browser already put it, when it went straight to Storage. */
  file_path: string | null;
  uploaded_by: string;
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** An upload, checked. */
export function parseUpload(body: Record<string, unknown>): { fields: UploadFields } | { errors: string[] } {
  const errors: string[] = [];
  const text = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");

  const provider_id = text("provider_id");
  if (!UUID.test(provider_id)) errors.push("Choose the provider this sheet is from.");
  const name = text("name");
  if (name === "") errors.push("Give the sheet a name, such as \"BRP 2026 rates\".");
  const effective_from = text("effective_from");
  if (!DATE.test(effective_from)) errors.push("Give the date the sheet takes effect.");
  const to = text("effective_to");
  const effective_to = to === "" ? null : to;
  if (effective_to !== null && !DATE.test(effective_to)) errors.push("The end date is not a date.");
  if (effective_to !== null && DATE.test(effective_from) && effective_to < effective_from) {
    errors.push("The end date is before the start date.");
  }
  const uploaded_by = text("uploaded_by");
  if (uploaded_by === "") errors.push("Who is uploading the sheet is missing.");

  const file_name = text("file_name");
  const kind = fileTypeFor(file_name);
  if (!kind) errors.push("The file must be a PDF, an Excel workbook (XLSX or XLS) or a CSV.");

  // Either the browser already put the file in Storage and says where, or the
  // file comes in the request. The path must be this provider's.
  const path = text("file_path");
  let bytes: Uint8Array | null = null;
  if (path !== "") {
    const m = path.match(UPLOADED_PATH);
    if (!m || m[1].toLowerCase() !== provider_id.toLowerCase()) errors.push("The uploaded file could not be found.");
  } else {
    bytes = decodeBase64(text("file_base64"));
    if (!bytes || bytes.length === 0) errors.push("The file is empty or did not arrive.");
    else if (bytes.length > MAX_FILE_BYTES) errors.push("The file is larger than 20 MB.");
  }

  if (errors.length > 0 || !kind) return { errors };
  return {
    fields: {
      provider_id, name, effective_from, effective_to, file_name,
      file_type: kind.type, mime: kind.mime, bytes, file_path: path === "" ? null : path, uploaded_by,
    },
  };
}

const INT_FIELDS = [
  "year_min", "year_max", "max_age_years", "max_odometer", "engine_cc_min",
  "engine_cc_max", "max_months_in_service", "term_months", "term_miles",
] as const;
const MONEY_FIELDS = ["deductible", "dealer_cost", "suggested_retail"] as const;
const TEXT_FIELDS = ["product_code", "product_name", "family_code", "plan"] as const;
const LIST_FIELDS = ["makes", "model_contains", "vehicle_types", "conditions"] as const;

const LABELS: Record<string, string> = {
  year_min: "First model year", year_max: "Last model year", max_age_years: "Maximum age in years",
  max_odometer: "Maximum odometer", engine_cc_min: "Smallest engine (cc)", engine_cc_max: "Largest engine (cc)",
  max_months_in_service: "Maximum months in service", term_months: "Term (months)",
  term_miles: "Term (miles)", deductible: "Deductible", dealer_cost: "Dealer cost",
  suggested_retail: "Suggested retail", product_code: "Product code", product_name: "Product name",
};

/**
 * A correction to one rate, checked. Only the fields sent are changed. Lists
 * arrive as comma-separated text, the way a person types them.
 */
export function parseRateEdit(
  body: Record<string, unknown>
): { patch: Record<string, unknown> } | { errors: string[] } {
  const errors: string[] = [];
  const patch: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const raw = (k: string) => (body[k] === null || body[k] === undefined ? "" : String(body[k]).trim());

  for (const k of INT_FIELDS) {
    if (!has(k)) continue;
    const v = raw(k).replace(/,/g, "");
    if (v === "") patch[k] = null;
    else if (/^\d+$/.test(v)) patch[k] = Number(v);
    else errors.push(`${LABELS[k]} must be a whole number.`);
  }
  for (const k of MONEY_FIELDS) {
    if (!has(k)) continue;
    const v = raw(k).replace(/[$,\s]/g, "");
    if (v === "") patch[k] = null;
    else if (/^\d+(\.\d{1,2})?$/.test(v)) patch[k] = Number(v);
    else errors.push(`${LABELS[k]} must be an amount in dollars and cents.`);
  }
  for (const k of TEXT_FIELDS) {
    if (!has(k)) continue;
    const v = raw(k);
    if ((k === "product_code" || k === "product_name") && v === "") errors.push(`${LABELS[k]} cannot be blank.`);
    else patch[k] = v === "" ? null : v;
  }
  for (const k of LIST_FIELDS) {
    if (!has(k)) continue;
    const items = (Array.isArray(body[k]) ? (body[k] as unknown[]).map(String) : raw(k).split(","))
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (k === "vehicle_types") {
      const up = items.map((s) => s.toUpperCase());
      const bad = up.filter((v) => !RATEABLE_VTYPES.includes(v));
      if (bad.length > 0) errors.push(`Vehicle types must be from: ${RATEABLE_VTYPES.join(", ")}.`);
      patch[k] = up;
    } else if (k === "conditions") {
      const norm = items.map((s) => (s.toLowerCase() === "new" ? "New" : s.toLowerCase() === "used" ? "Used" : s));
      if (norm.some((c) => c !== "New" && c !== "Used")) errors.push("New or Used must be New, Used, or both.");
      patch[k] = [...new Set(norm)];
    } else {
      patch[k] = [...new Set(items)];
    }
  }
  if (has("category")) {
    const c = raw("category");
    if (c === "") patch.category = null;
    else if ((CATEGORIES as readonly string[]).includes(c)) patch.category = c;
    else errors.push(`Category must be one of: ${CATEGORIES.join(", ")}.`);
  }

  if (errors.length > 0) return { errors };
  if (Object.keys(patch).length === 0) return { errors: ["Nothing was changed."] };
  return { patch };
}
