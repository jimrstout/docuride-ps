// _shared/details-offer.ts: what a rating changes on Details.
//
// Details (fni-session-verify GET) shows the deal; a rating changes only some
// of it: the rating line and its time, the product count, the notices about
// what the fresh offer took away, the menu's hidden slots, the selections
// Rate again could not keep, the menu's columns (the template the rating
// recorded), the contracts panel and its Submit confirmation, and the
// session's status. offerParts builds exactly those, and both of its callers
// use it:
//
//   fni-session-verify   every Details load, for those keys of the sheet
//   fni-rate-vehicle     the Rate again answer, so Details updates in place
//                        without reading the whole deal again
//
// One function for both is what makes the screen after Rate again the same as
// the screen after a reload. Moved here from fni-session-verify unchanged.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { unplacedOffers } from "./menu-templates.ts";
import { loadSheet } from "./menu-prepare-rows.ts";
import { providerMessages } from "./stale-offers.ts";
import { shortLineup } from "./brands.ts";
import { presetDealType } from "./menu-presets.ts";
import { offerRowsFor, tecAssuredAccount } from "./provider-rows.ts";
import { hostOf, QA_HOST } from "./contract-guard.ts";
import { currentRows, familiesFromRows, ratingSummary, type RatingRow } from "./rating-summary.ts";
import { columnsFor, isLevel } from "./menu-columns.ts";
import {
  HELD_MESSAGE,
  isRatedAgainEvent,
  OUT_OF_DATE_MESSAGE,
  RATED_AGAIN_PREFIX,
  REFRESHED_HELD_EVENT,
  REFRESHED_NOTE,
  REFRESHED_UNCHANGED_EVENT,
  refreshState,
  spentSelections,
  type RefreshEvent,
  type SpentSelection,
  type VoidedContract,
} from "./spent-rates.ts";
import { money } from "./money.ts";
import { resolvedSlotsFor } from "./menu-template-rows.ts";
import { workDriveFileUrl } from "./workdrive-links.ts";
import { HOLD_BUCKET } from "./contract-documents.ts";
import { editTargetFor } from "./verification.ts";
import { applyStaffEdits, parseStaffEdits } from "./staff-edits.ts";
import { dealDates } from "./deal-dates.ts";
import { dayLabel } from "./store-day.ts";
import { SUBMIT_ROW_COLUMNS, submitConfirmation, type SubmitRow } from "./saved-selections.ts";

/** The keys of the Details sheet a rating changes; everything else stays as it was. */
export const OFFER_KEYS = [
  "rating",
  "rating_differences",
  "menu_columns",
  "unplaced_offers",
  "rating_notices",
  "hidden_slots",
  "contracts_panel",
] as const;

/**
 * Everything a rating changes on Details, for this session row as it now
 * stands. The session's status goes beside it: a rating with no selections
 * and no live contract moves it.
 */
export async function offerParts(supabase: SupabaseClient, s: Record<string, unknown>) {
  // ── The rating, per provider ──────────────────────────────────────────
  const rows = currentRows(
    (await offerRowsFor(supabase, s.id as string)) as unknown as RatingRow[],
    s.rated_provider_ids as string[] | null
  );
  const summary = ratingSummary(rows);

  // ── The menu's slots, as rating left them ─────────────────────────────
  // A slot nothing was offered for is not shown to the customer. Staff see
  // which, and why, here: it is the answer to "where did Theft go?".
  const resolved = summary.state === "Rated" && !summary.out_of_date
    ? await resolvedSlotsFor(
        supabase,
        typeof s.menu_template_id === "string" ? s.menu_template_id : null,
        familiesFromRows(rows)
      )
    : null;

  // ── What rating again took away, and what the provider said ──────────
  // A prepared menu's choices no longer offered, and deal prices that no
  // longer fit, from the same sheet Prepare and Present menu read; and the
  // provider's words about any product it did not rate ("No rates
  // available"), naming the product (_shared/stale-offers.ts).
  const ratingNotices: string[] = [];
  if (summary.state === "Rated" && !summary.out_of_date) {
    if (s.menu_prepared) ratingNotices.push(...(await loadSheet(supabase, s)).sheet.notices);
    const codes = rows.flatMap((r) => {
      const ps = ((r.response_payload as { quote?: { vehicles?: { products?: { unique?: string }[] }[] } } | null)?.quote?.vehicles ?? [])
        .flatMap((v) => v.products ?? []);
      return ps.map((p) => String(p.unique ?? ""));
    });
    const { data: named } = codes.length
      ? await supabase.schema("fni").from("product_catalog").select("product_code, display_name").in("product_code", codes).is("store_id", null)
      : { data: [] };
    const names = new Map(((named ?? []) as { product_code: string; display_name: string }[]).map((c) => [c.product_code, c.display_name]));
    for (const r of rows) {
      ratingNotices.push(...providerMessages(r.response_payload, (code, label) => names.get(code) ?? label.split(" - ")[0]));
    }
    // The safety net: a financed rating with no Mechanical Protection or no
    // GAP says so, never silently (_shared/brands.ts shortLineup).
    const types = rows
      .filter((r) => r.provider?.adapter === "TecAssured")
      .flatMap((r) => ((r.response_payload as { quote?: { vehicles?: { products?: { ptype?: string }[] }[] } } | null)?.quote?.vehicles ?? [])
        .flatMap((v) => (v.products ?? []).map((p) => String(p.ptype ?? ""))));
    ratingNotices.push(...shortLineup(types, presetDealType(s.finance_type) === "Financed"));
  }

  const [differences, columns, panel] = await Promise.all([
    ratingDifferences(supabase, s.id as string),
    menuColumnsFor(supabase, s),
    contractsPanel(supabase, s),
  ]);

  return {
    session_status: s.status,
    rating: {
      state: summary.state,
      product_count: summary.product_count,
      out_of_date: summary.out_of_date,
      rated_at: summary.rated_at,
      detail: summary.state === "Rated" ? null : summary.detail,
      providers: summary.providers.map((p) => ({
        name: p.name,
        state: p.state,
        line: p.line,
        error: p.error,
        error_at: p.error_at,
        kept_error: p.kept_error,
        kept_error_at: p.kept_error_at,
      })),
    },
    rating_differences: differences,
    menu_columns: columns,
    // Offers no menu row shows, said in words rather than dropped: "2
    // Maintenance plans were offered but no menu row uses them."
    unplaced_offers: resolved ? unplacedOffers(resolved, familiesFromRows(rows)) : [],
    // What rating again took off the menu, prices it no longer applies, and
    // the provider's words about products it did not rate.
    rating_notices: ratingNotices,
    // Slots hidden from the customer on this deal, with the reason for staff.
    hidden_slots: (resolved ?? [])
      .filter((r) => r.hidden)
      .map((r) => ({ title: r.title, note: r.staff_note })),
    // The staff contracts panel, once the customer has finished the planner.
    contracts_panel: panel,
  };
}

const PLANNER_DONE = ["Products Selected", "Agreement Created", "Finalized"];

/**
 * The staff contracts panel: what the customer chose from providers
 * contracted through their API, and every contract submitted for them,
 * voided ones included, with its saved WorkDrive file.
 */
export async function contractsPanel(supabase: SupabaseClient, s: Record<string, unknown>) {
  if (!PLANNER_DONE.includes(String(s.status))) return null;

  const { data: chosen } = await supabase
    .schema("fni")
    .from("selected_products")
    .select("provider_id, provider_product_id, product_name, term_months, term_miles, customer_price, providers!inner(name, contract_method)")
    .eq("session_id", s.id as string)
    .eq("disposition", "Included")
    .eq("providers.contract_method", "Through API")
    .order("product_name");
  const chosenRows = (chosen ?? []) as unknown as {
    provider_id: string;
    provider_product_id: string | null;
    product_name: string;
    term_months: number | null;
    term_miles: number | null;
    customer_price: number | null;
    providers: { name: string };
  }[];
  const programs = await programNamesFor(supabase, chosenRows.map((c) => c.provider_id));
  const programOf = (providerId: unknown, code: unknown) =>
    programs.get(`${providerId}|${code}`) ?? null;
  const selections = chosenRows.map((c) => ({
    product_name: c.product_name,
    program_name: programOf(c.provider_id, c.provider_product_id),
    provider_name: c.providers.name,
    term_months: c.term_months,
    term_miles: c.term_miles,
    customer_price: c.customer_price,
  }));
  if (selections.length === 0) return null;

  const { data: agreement } = await supabase
    .schema("fni")
    .from("agreements")
    .select("id")
    .eq("session_id", s.id as string)
    .maybeSingle();
  let contracts: Record<string, unknown>[] = [];
  if (agreement) {
    const { data } = await supabase
      .schema("fni")
      .from("agreement_products")
      .select(
        "provider_id, provider_product_id, contract_number, product_name, status, document_position, " +
          "workdrive_file_id, workdrive_file_name, " +
          "workdrive_saved_at, voided_by, voided_at, void_reason, page_count, document_status, document_storage_path"
      )
      .eq("agreement_id", (agreement as { id: string }).id)
      .is("recorded_by", null)
      .order("document_position", { ascending: true, nullsFirst: false });
    contracts = await Promise.all(
      ((data ?? []) as unknown as Record<string, unknown>[]).map(async (c) => {
        // A held PDF, seen through a ten-minute link: the bucket is private.
        let view: string | null = null;
        if (c.document_storage_path) {
          const { data: link } = await supabase.storage
            .from(HOLD_BUCKET)
            .createSignedUrl(String(c.document_storage_path), 600);
          view = link?.signedUrl ?? null;
        }
        const { document_storage_path: _path, provider_id: _provider, ...shown } = c;
        return {
          ...shown,
          program_name: programOf(c.provider_id, c.provider_product_id),
          held: !!c.document_storage_path,
          view_pdf_url: view,
          workdrive_url: c.workdrive_file_id ? workDriveFileUrl(String(c.workdrive_file_id)) : null,
        };
      })
    );
  }
  // Held documents not in the Deal Jacket yet, voided ones included.
  const waiting = contracts.filter((c) => c.held && !c.workdrive_file_id).length;
  // Asked only of a test session: nothing else depends on it.
  const onQa = s.is_test === true && (await onQaServer(supabase, String(s.store_id)));
  return {
    provider_name: selections[0].provider_name,
    selections,
    contracts,
    waiting_count: waiting,
    confirmation: await submitConfirmationFor(supabase, s, onQa),
  };
}

/**
 * What the Submit confirmation shows: the deal, the buyer, the sale date, and
 * each product with the price the submit sends for it. Read with the same
 * columns and the same function as fni-contract-submit's own selections
 * (_shared/saved-selections.ts), so the modal and the payload cannot differ.
 * The buyer's name and the sale date are the staff values where there are
 * any, as the submit sends them.
 */
async function submitConfirmationFor(supabase: SupabaseClient, s: Record<string, unknown>, onQa: boolean) {
  const { data } = await supabase
    .schema("fni")
    .from("selected_products")
    .select(SUBMIT_ROW_COLUMNS)
    .eq("session_id", s.id as string)
    .eq("disposition", "Included")
    .order("product_name");
  const edited = applyStaffEdits(s, parseStaffEdits(s.staff_edits), editTargetFor);
  const sale = dealDates(edited).sale;
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return {
    deal_number: s.deal_number ?? null,
    buyer_name:
      text(edited.buyer_display_name) ??
      ([text(edited.buyer_first_name), text(edited.buyer_last_name)].filter(Boolean).join(" ") || null),
    sale_date: sale,
    sale_date_label: sale ? dayLabel(sale) : null,
    // A test session on the QA server is sent at the provider's maximum
    // (pricePolicy's "Test at maximum", _shared/price-cap.ts), and the modal
    // says so beside these prices.
    test_at_maximum: s.is_test === true && onQa,
    // A rate whose contract was voided, and the last refresh of it
    // (_shared/spent-rates.ts): Submit rates the deal again first when one is
    // spent, and the confirmation says what that refresh found.
    ...(await spentStateFor(supabase, s, (data ?? []) as unknown as (SpentSelection & { providers: { contract_method: string | null } | null })[])),
    ...submitConfirmation((data ?? []) as unknown as SubmitRow[]),
  };
}

/** Whether a selected rate is spent, and what the last refresh found. */
async function spentStateFor(
  supabase: SupabaseClient,
  s: Record<string, unknown>,
  rows: (SpentSelection & { providers: { contract_method: string | null } | null })[]
) {
  const selections = rows.filter((r) => r.providers?.contract_method !== "Recorded by Staff");
  const { data: agreements } = await supabase.schema("fni").from("agreements").select("id").eq("session_id", s.id as string);
  const ids = ((agreements ?? []) as { id: string }[]).map((a) => a.id);
  const { data: contracts } = ids.length > 0
    ? await supabase.schema("fni").from("agreement_products").select("provider_product_id, rate_unique_id, status, voided_at").in("agreement_id", ids)
    : { data: [] };
  const offers = await offerRowsFor(supabase, s.id as string);
  const ratedAt = offers.find((o) => o.provider?.adapter === "TecAssured")?.rated_at ?? null;
  const state = refreshState(selections, await latestRefreshEvent(supabase, s.id as string), money);
  return {
    spent: spentSelections(selections, (contracts ?? []) as VoidedContract[], ratedAt).map((x) => x.product_name ?? x.provider_product_id),
    refresh_note: state?.kind === "refreshed" ? REFRESHED_NOTE : null,
    held: state?.kind === "held" ? { message: HELD_MESSAGE, differences: state.differences } : null,
  };
}

/**
 * The latest refresh of the rating: one before Submit (a spent rate) or a
 * press of Rate again on Details. Read as two lookups, since the Rate again
 * event carries the person's initials in its name.
 */
async function latestRefreshEvent(supabase: SupabaseClient, sessionId: string): Promise<RefreshEvent | null> {
  const pick = (q: PromiseLike<{ data: unknown }>) => q.then((r) => (r.data as RefreshEvent | null) ?? null);
  const base = () =>
    supabase.schema("fni").from("session_events").select("event, created_at, detail").eq("session_id", sessionId);
  const [refresh, again] = await Promise.all([
    pick(base().in("event", [REFRESHED_UNCHANGED_EVENT, REFRESHED_HELD_EVENT]).order("created_at", { ascending: false }).limit(1).maybeSingle()),
    pick(base().like("event", `${RATED_AGAIN_PREFIX}%`).order("created_at", { ascending: false }).limit(1).maybeSingle()),
  ]);
  if (!refresh) return again;
  if (!again) return refresh;
  return Date.parse(again.created_at) > Date.parse(refresh.created_at) ? again : refresh;
}

/**
 * The selections Rate again could not keep: still on an old rate the fresh
 * offer does not match to the cent, each with what changed. Shown on Details
 * so staff can choose them again. Null when there are none.
 */
export async function ratingDifferences(supabase: SupabaseClient, sessionId: string) {
  const { data } = await supabase
    .schema("fni")
    .from("selected_products")
    .select("provider_product_id, rate_unique_id, providers(contract_method)")
    .eq("session_id", sessionId)
    .eq("disposition", "Included");
  const rows = ((data ?? []) as unknown as { provider_product_id: string; rate_unique_id: string | null; providers: { contract_method: string | null } | null }[])
    .filter((r) => r.providers?.contract_method !== "Recorded by Staff");
  const latest = await latestRefreshEvent(supabase, sessionId);
  if (!latest || !isRatedAgainEvent(latest.event)) return null;
  const state = refreshState(rows, latest, money);
  return state?.kind === "held" ? { message: OUT_OF_DATE_MESSAGE, differences: state.differences } : null;
}

export async function onQaServer(supabase: SupabaseClient, storeId: string): Promise<boolean> {
  const account = await tecAssuredAccount(supabase, storeId).catch(() => null);
  if (!account?.credential_id) return false;
  const { data } = await supabase
    .schema("fni")
    .from("provider_credentials")
    .select("api_base_url")
    .eq("id", account.credential_id)
    .maybeSingle();
  return hostOf((data as { api_base_url?: string | null } | null)?.api_base_url) === QA_HOST;
}

/**
 * TecAssured's program name for each catalog product, keyed provider|code.
 * Staff only: it tells twins apart ("USED BRONZE ON-ROAD NON-EU").
 */
export async function programNamesFor(
  supabase: SupabaseClient,
  providerIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(providerIds)];
  if (ids.length === 0) return out;
  const { data } = await supabase
    .schema("fni")
    .from("product_catalog")
    .select("provider_id, product_code, provider_program_name")
    .in("provider_id", ids)
    .is("store_id", null)
    .not("provider_program_name", "is", null);
  for (const r of (data ?? []) as { provider_id: string; product_code: string; provider_program_name: string }[]) {
    out.set(`${r.provider_id}|${r.product_code}`, r.provider_program_name);
  }
  return out;
}

// ── The conventional menu's columns for this deal ─────────────────────────
//
// The menu template's columns (or the default layout), each with the coverage
// level its products start at: the template's, unless a manager set one for
// this deal (sessions.menu_column_levels, by column position).

export async function menuColumnsFor(supabase: SupabaseClient, s: Record<string, unknown>) {
  const templateId = typeof s.menu_template_id === "string" ? s.menu_template_id : null;
  const { data } = templateId
    ? await supabase
        .schema("fni")
        .from("menu_template_columns")
        .select("position, name, preset_categories, starting_level")
        .eq("template_id", templateId)
    : { data: [] };
  const deal = (s.menu_column_levels ?? {}) as Record<string, unknown>;
  return columnsFor(
    (data ?? []) as { position: number; name: string; preset_categories: string[] | null; starting_level: string | null }[]
  ).columns.map((c, i) => {
    const own = deal[String(i + 1)];
    return { position: i + 1, name: c.name, template_level: c.starting_level, level: isLevel(own) ? own : c.starting_level };
  });
}

