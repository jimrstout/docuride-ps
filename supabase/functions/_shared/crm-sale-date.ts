// _shared/crm-sale-date.ts
//
// The CRM sale date is the only sale date (docs/multi-provider.md section 24).
//
// The DocuRide record's Sale_Date is changed in the CRM only. PS never writes
// it and never edits it. fni.sessions.sale_date is the last value PS read from
// the CRM, kept only to notice changes, and it is written only here and on
// session start (fni-session-start), each from a CRM read.
//
// Read from the CRM by:
//
//   zoho-sync            every CRM edit, after the deals mirror is written
//   Details              when it loads (fni-session-verify GET), and Refresh
//   rating               before every rate and Rate again (fni-rate-vehicle)
//   Submit               immediately before anything is sent
//                        (fni-contract-submit); a failed read refuses it
//
// When the value read differs from the copy, fni.record_crm_sale_date
// (migration 0044) writes it over the value the caller read, adds the session
// event "Sale date changed in the CRM from <old> to <new>" (System), and,
// when the month rule below says so, marks the rated offers out of date and
// sends a verified deal back to Needs Verification. The session's open-until
// time follows the new date by trigger.
//
// The month rule is the one PR 53 set (_shared/sale-date.ts): a move within the
// same calendar month keeps the rating current, a move into another month or
// across a Published price sheet's first or last day needs a re-rate. When the
// price sheets cannot be read, a re-rate is the safe answer.
//
// Logs carry the session id and the outcome only, never a date or the record.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isoDate } from "./deal-dates.ts";
import { publishedSheetDates } from "./price-sheet-rows.ts";
import { priceSheetBoundaries, saleDateMoveNeedsRerate } from "./sale-date.ts";

/** The CRM module the deal's record lives in. */
export const CRM_MODULE = "DocuRide";

/** How long a Details load or a rating waits for the CRM before using the copy. */
export const CRM_READ_BUDGET_MS = 3000;

export type RecordOutcome = "Changed" | "Unchanged" | "Changed meanwhile" | "No session";

/** The session fields this needs. */
export interface SaleDateSession {
  id: string;
  tenant_id?: unknown;
  zoho_deal_id?: unknown;
  sale_date?: unknown;
}

/** The record's Sale_Date as "2026-09-26", or null when it has none. */
export function crmSaleDate(record: Record<string, unknown> | null | undefined): string | null {
  return isoDate(record?.Sale_Date);
}

/**
 * Record a Sale_Date read from the CRM. Returns the outcome and the sale date
 * the session now has: the new one when it changed, the other writer's when
 * one recorded a value first, the copy otherwise. Throws when it cannot be
 * recorded.
 */
export async function recordCrmSaleDate(
  supabase: SupabaseClient,
  s: SaleDateSession,
  next: string | null
): Promise<{ outcome: RecordOutcome; sale: string | null }> {
  const old = isoDate(s.sale_date);
  if (old === next) return { outcome: "Unchanged", sale: old };
  const sheets = await publishedSheetDates(supabase, s.tenant_id);
  const rerate = saleDateMoveNeedsRerate(old, next, sheets === null ? null : priceSheetBoundaries(sheets));
  const { data, error } = await supabase.schema("fni").rpc("record_crm_sale_date", {
    p_session: s.id,
    p_expected: old,
    p_new: next,
    p_rerate: rerate,
  });
  if (error) throw new Error(`The sale date from the CRM could not be recorded (${error.code ?? "error"}).`);
  const row = ((data ?? []) as { outcome: RecordOutcome; old_sale_date: string | null }[])[0];
  const outcome = row?.outcome ?? "No session";
  console.log("crm-sale-date: recorded", { session: s.id, outcome, rerate_needed: outcome === "Changed" && rerate });
  if (outcome === "Changed") return { outcome, sale: next };
  if (outcome === "Changed meanwhile") return { outcome, sale: isoDate(row?.old_sale_date) };
  return { outcome, sale: old };
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The CRM took too long to answer.")), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export interface FreshSaleDate {
  /** The sale date to use. */
  sale: string | null;
  /** True when it was read from the CRM just now; false when it is the copy. */
  fresh: boolean;
  outcome: RecordOutcome | null;
  /** Why it could not be read, when it could not. */
  problem: string | null;
}

/**
 * Read the deal's Sale_Date from the CRM now and record it. When the CRM cannot
 * be read in time, or the session has no CRM record, the copy is returned with
 * `fresh: false` and the reason: Details and rating carry on with it, Submit
 * refuses. Never throws.
 */
export async function freshSaleDate(
  supabase: SupabaseClient,
  s: SaleDateSession,
  budgetMs = CRM_READ_BUDGET_MS,
  // The CRM read. Loaded only when called, so a Node test can hold this file.
  read: (module: string, id: string) => Promise<Record<string, unknown> | null> = async (module, id) =>
    (await import("./zoho.ts")).getRecord(module, id)
): Promise<FreshSaleDate> {
  const copy = isoDate(s.sale_date);
  const zohoId = typeof s.zoho_deal_id === "string" && s.zoho_deal_id !== "" ? s.zoho_deal_id : null;
  if (!zohoId) return { sale: copy, fresh: false, outcome: null, problem: "This session has no CRM record to read the sale date from." };
  try {
    const record = await within(read(CRM_MODULE, zohoId), budgetMs);
    if (!record) return { sale: copy, fresh: false, outcome: null, problem: "The CRM has no DocuRide record for this deal any more." };
    const { outcome, sale } = await recordCrmSaleDate(supabase, s, crmSaleDate(record as Record<string, unknown>));
    return { sale, fresh: outcome !== "Changed meanwhile", outcome, problem: null };
  } catch (err) {
    console.error("crm-sale-date: not read", { session: s.id, reason: err instanceof Error ? err.name : "error" });
    return { sale: copy, fresh: false, outcome: null, problem: "The sale date could not be read from the CRM just now." };
  }
}
