// _shared/deal-jacket-file.ts
//
// Filing a session's held contract documents into the deal's Deal Jacket.
// One function for every caller: fni-documents-to-deal-jacket (the CRM's call
// and Verify's button) and zoho-sync, when the CRM has just given the deal its
// folders.
//
// ── When the CRM gives the deal its folders (zoho-sync) ───────────────────
// The CRM Flow "Generate Contract Documents" writes the deal's folder IDs to
// the DocuRide record, and zoho-sync keeps them on the session through
// fni.record_deal_folders (migration 0041). When that call says the Deal
// Jacket and Signed Documents folders both became known with this write
// (folders_became_ready), zoho-sync files the session's waiting documents,
// after it has answered, off the sync's own path:
//
//   filed      one session event, "Contracts filed to Deal Jacket when CRM
//              created the deal's folders", with the count
//   not filed  one session event per contract, "Contract not filed to Deal
//              Jacket", with the contract number and the reason
//   nothing    no event: nothing was waiting, or another request was filing
//              it at the same moment
//
// A failure never fails the sync: it is a session event, signed System. The
// folders are read from the session first, then dc.deals as a read-only
// fallback. Events never carry a folder ID or a file name, which holds the
// buyer's name.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dcDealFolders } from "./dc-deal-folders.ts";
import { liveMoveDeps } from "./deal-jacket-live.ts";
import {
  FILED_EVENT,
  FILING_FAILED_EVENT,
  REFILED_EVENT,
  REFILING_FAILED_EVENT,
  filingEvents,
  moveHeldDocuments,
  type FilingEvent,
  type HeldDocument,
  type JacketFolders,
  type MoveDeps,
  type MoveLine,
} from "./deal-jacket-move.ts";
import { resolveFolders } from "./deal-jacket-request.ts";

/** Every document PS holds for these sessions, in the order they are filed. */
export async function heldDocuments(supabase: SupabaseClient, sessionIds: string[]): Promise<HeldDocument[]> {
  if (sessionIds.length === 0) return [];
  const { data: agreements, error: agErr } = await supabase
    .schema("fni")
    .from("agreements")
    .select("id")
    .in("session_id", sessionIds);
  if (agErr) throw new Error(`The deal's contracts could not be read (${agErr.code ?? "error"}).`);
  const agreementIds = ((agreements ?? []) as { id: string }[]).map((a) => a.id);
  if (agreementIds.length === 0) return [];
  const { data: rows, error: rowErr } = await supabase
    .schema("fni")
    .from("agreement_products")
    .select("id, contract_number, document_name, document_storage_path, document_status, workdrive_file_id, document_position")
    .in("agreement_id", agreementIds)
    .is("recorded_by", null)
    .not("document_storage_path", "is", null)
    .order("document_position", { ascending: true, nullsFirst: false });
  if (rowErr) throw new Error(`The deal's documents could not be read (${rowErr.code ?? "error"}).`);
  return (rows ?? []) as unknown as HeldDocument[];
}

/** File these sessions' held documents into the folders. */
export async function fileHeldDocuments(
  supabase: SupabaseClient,
  sessionIds: string[],
  folders: JacketFolders,
  deps: MoveDeps = liveMoveDeps(supabase),
  opts: { refile?: boolean } = {}
): Promise<MoveLine[]> {
  return moveHeldDocuments(await heldDocuments(supabase, sessionIds), folders, deps, opts);
}

/**
 * zoho-sync's filing, once the deal's folders became known. Never throws:
 * whatever goes wrong is a session event, and the sync is not touched.
 */
export async function fileWhenFoldersReady(
  supabase: SupabaseClient,
  sessionId: string,
  deps?: MoveDeps
): Promise<FilingEvent[]> {
  let events: FilingEvent[];
  try {
    const { data: session, error } = await supabase
      .schema("fni")
      .from("sessions")
      .select("id, zoho_deal_id, deal_number, deal_jacket_folder_id, signed_documents_folder_id")
      .eq("id", sessionId)
      .maybeSingle();
    if (error || !session) throw new Error(`The session could not be read (${error?.code ?? "not found"}).`);
    const s = session as {
      zoho_deal_id: string | null;
      deal_number: string | null;
      deal_jacket_folder_id: string | null;
      signed_documents_folder_id: string | null;
    };
    // The session's own folders first; dc.deals only for one still unknown.
    const dc = s.deal_jacket_folder_id && s.signed_documents_folder_id
      ? null
      : await dcDealFolders(s.zoho_deal_id, s.deal_number).catch(() => null);
    const resolved = resolveFolders({ deal_jacket_folder_id: null, signed_documents_folder_id: null }, dc, s);
    if (!resolved) throw new Error("The deal's Deal Jacket or Signed Documents folder is not known.");
    events = filingEvents(await fileHeldDocuments(supabase, [sessionId], resolved.folders, deps));
  } catch (err) {
    events = [{
      event: FILING_FAILED_EVENT,
      detail: { reason: err instanceof Error ? err.message : "Something went wrong." },
    }];
  }
  if (events.length > 0) {
    const { error } = await supabase
      .schema("fni")
      .from("session_events")
      .insert(events.map((e) => ({ session_id: sessionId, event: e.event, detail: e.detail, created_by: "System" })));
    if (error) console.error("deal-jacket-file: filing events not recorded", { code: error.code ?? null });
  }
  console.log("deal-jacket-file: filed on folders ready", {
    filed: events.find((e) => e.event === FILED_EVENT)?.detail.count ?? 0,
    not_filed: events.filter((e) => e.event !== FILED_EVENT).length,
  });
  return events;
}

/**
 * fni-documents-generated's filing, after the CRM regenerated the deal's
 * documents: every held document filed again into the session's Deal Jacket,
 * an earlier filing being history and not a reason to skip. A same-named file
 * goes to the trash first, as Get document does. Never throws: the outcome is
 * session events signed `by`, and a contract that failed is left for the next
 * regeneration or the Details button.
 */
export async function refileAfterRegenerate(
  supabase: SupabaseClient,
  sessionId: string,
  folders: JacketFolders,
  by: string,
  deps?: MoveDeps
): Promise<FilingEvent[]> {
  let events: FilingEvent[];
  try {
    events = filingEvents(await fileHeldDocuments(supabase, [sessionId], folders, deps, { refile: true }), REFILED_EVENT);
  } catch (err) {
    events = [{ event: REFILING_FAILED_EVENT, detail: { reason: err instanceof Error ? err.message : "Something went wrong." } }];
  }
  if (events.length > 0) {
    const { error } = await supabase
      .schema("fni")
      .from("session_events")
      .insert(events.map((e) => ({ session_id: sessionId, event: e.event, detail: e.detail, created_by: by })));
    if (error) console.error("deal-jacket-file: refile events not recorded", { code: error.code ?? null });
  }
  console.log("deal-jacket-file: refiled after regenerate", {
    filed: events.find((e) => e.event === REFILED_EVENT)?.detail.count ?? 0,
    not_filed: events.filter((e) => e.event !== REFILED_EVENT).length,
  });
  return events;
}
