// _shared/oem-contracts.ts
//
// OEM contracts, recorded by staff. See docs/multi-provider.md, section 10.
//
// A Price Sheet provider (BRP, Kawasaki and the rest) has no API. DocuRide
// never submits or voids its contracts anywhere: staff write the contract on
// the OEM's own system and record it here, with the signed document. The row
// is an ordinary fni.agreement_products row, status 'Live', with recorded_by
// set, and screens call it "Recorded".
//
// Pure, so a Node test can hold the rules; every refusal is a sentence a
// person can act on.

import { safeFileName } from "./price-sheet-admin.ts";

/** The private Storage bucket signed OEM contracts are kept in. */
export const OEM_BUCKET = "oem-contracts";

/** fni.providers.contract_method for a provider whose contracts staff record. */
export const RECORDED_BY_STAFF = "Recorded by Staff";

/** Twenty megabytes, the same ceiling as a price sheet. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DOCUMENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

/**
 * Where a signed contract lives: session id, a fresh id, safe file name. A
 * path the browser reports back is held to this shape and to its session.
 */
export const DOCUMENT_PATH = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/([A-Za-z0-9._-]{1,120})$/i;

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The storage path for a new signed contract, or a refusal. */
export function documentPathFor(
  sessionId: string,
  fileName: string,
  id: string
): { path: string } | { error: string } {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (!DOCUMENT_TYPES[ext]) return { error: "The signed contract must be a PDF, JPG or PNG." };
  return { path: `${sessionId}/${id}/${safeFileName(fileName)}` };
}

/** What a contract reads as on a screen. */
export function contractStateLabel(row: { status: string; recorded_by?: string | null }): string {
  if (row.status === "Live" && text(row.recorded_by) !== "") return "Recorded";
  return row.status;
}

/** A recorded contract: DocuRide never calls a provider about it. */
export function isRecorded(row: { recorded_by?: string | null }): boolean {
  return text(row.recorded_by) !== "";
}

/**
 * The selections a provider API is asked to contract, and the ones it is not.
 * A selection whose rate is one of the session's Recorded-by-Staff selections
 * is held back and reported, never sent.
 */
export function splitSelections<T extends { rate_unique: string }>(
  selections: T[],
  recordedRateIds: Set<string>
): { toProvider: T[]; recordedByStaff: T[] } {
  const toProvider: T[] = [];
  const recordedByStaff: T[] = [];
  for (const s of selections) {
    (recordedRateIds.has(s.rate_unique) ? recordedByStaff : toProvider).push(s);
  }
  return { toProvider, recordedByStaff };
}

export interface RecordFields {
  selected_product_id: string;
  contract_number: string;
  recorded_by: string;
  document_path: string;
  filename: string;
}

/** Checks a request to record an OEM contract. */
export function parseRecord(
  body: Record<string, unknown>,
  sessionId: string
): { fields: RecordFields | null; errors: string[] } {
  const errors: string[] = [];
  const selected = text(body.selected_product_id);
  const contract = text(body.contract_number);
  const by = text(body.recorded_by);
  const path = text(body.document_path);

  if (!UUID.test(selected)) errors.push("Choose the product this contract is for.");
  if (contract === "") errors.push("Type the contract number from the OEM's system.");
  else if (contract.length > 60) errors.push("That contract number is longer than 60 characters.");
  if (by === "") errors.push("Who is recording this is missing.");
  const m = DOCUMENT_PATH.exec(path);
  if (!m || m[1].toLowerCase() !== sessionId.toLowerCase()) {
    errors.push("Upload the signed contract first.");
  }

  if (errors.length > 0) return { fields: null, errors };
  return {
    fields: {
      selected_product_id: selected,
      contract_number: contract,
      recorded_by: by,
      document_path: path,
      filename: m![3],
    },
    errors,
  };
}

/** Checks a request to void a recorded OEM contract. */
export function parseVoid(body: Record<string, unknown>): {
  fields: { contract_number: string; voided_by: string; void_reason: string } | null;
  errors: string[];
} {
  const errors: string[] = [];
  const contract = text(body.contract_number);
  const by = text(body.voided_by);
  const reason = text(body.void_reason);
  if (contract === "") errors.push("Which contract is missing.");
  if (by === "") errors.push("Who is voiding this is missing.");
  if (reason === "") errors.push("Say why this contract is being voided.");
  if (errors.length > 0) return { fields: null, errors };
  return { fields: { contract_number: contract, voided_by: by, void_reason: reason }, errors };
}

// ── The catalog, from a published sheet ───────────────────────────────────

/**
 * Which of the planner's three goals a new OEM product starts under. Staff can
 * change it when they write its wording. The same pairing the Riders Advantage
 * catalog uses for the same categories.
 */
export function goalFor(category: string | null): string {
  switch (category) {
    case "Mechanical Protection":
    case "Maintenance":
      return "Keep ownership manageable";
    case "Theft":
      return "Keep the asset valuable";
    default:
      return "Keep ownership enjoyable";
  }
}

export interface SheetProduct {
  product_code: string;
  product_name: string;
  category: string | null;
  left_out?: boolean;
}

/**
 * The catalog rows a published sheet adds: one per product it offers that the
 * provider's catalog does not have yet. Name and category only. No customer
 * wording is written for it: the row is not presentable until staff write it
 * under Providers, Product wording. Rows already there are left as they are.
 */
export function newCatalogRows(
  rates: SheetProduct[],
  existingCodes: Set<string>,
  tenantId: string,
  providerId: string
): Record<string, unknown>[] {
  const seen = new Map<string, SheetProduct>();
  for (const r of rates) {
    if (r.left_out) continue;
    const code = text(r.product_code);
    if (code === "" || existingCodes.has(code) || seen.has(code)) continue;
    seen.set(code, r);
  }
  return [...seen.entries()].map(([code, r]) => ({
    tenant_id: tenantId,
    store_id: null,
    provider_id: providerId,
    product_code: code,
    display_name: text(r.product_name) || code,
    category: r.category ?? "Other",
    goal: goalFor(r.category),
  }));
}
