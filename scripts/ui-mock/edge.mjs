// scripts/ui-mock/edge.mjs: a stand-in for the Edge Functions the screens read.
//
// For the browser checks in scripts/ only. Made-up deals and sessions, no real
// data, nothing reaches Supabase. Session ids starting 1 are not rated yet,
// 2 rated and not prepared, 3 prepared. `delayMs` slows every answer, to watch
// the busy state, and `delays` one function's ("POST fni-rate-vehicle");
// `calls` counts each function's requests. Rate again rates the deal again in
// the mock: the rating's time, product count and a notice move, and the
// answer carries what changed (`details`), as fni-rate-vehicle's does. Verify
// and the first rate move a session that is not rated yet to verified and
// rated; every fni-session-verify action answers with the whole sheet, and
// the first rate with what it changed, as the Edge Functions do.

import http from "node:http";
import { menuParts, preparePayload } from "./layout-data.mjs";

/** The session the layout check opens. */
export const LAYOUT_SESSION = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a";

const F = (key, label, group, value, extra = {}) => ({
  key, label, group, value, source: value === null ? "Missing" : "CRM", editable: !["deal_number", "stock_number"].includes(key),
  provider_property: null, required: true, missing: value === null, note: null, original: null, original_source: null,
  in_crm: true, differs_from_crm: false, invalid: false, edited_by: null, edited_at: null, ...extra,
});
const fields = [
  F("deal_number", "Deal #", "Deal", "99901"), F("stock_number", "Stock #", "Deal", "ST-1234", { required: false }),
  F("deal_type", "Deal type", "Deal", "Finance"), F("sale_date", "Sale date", "Deal", "2026-11-02"),
  F("vin", "VIN", "Vehicle", "1ABCD23EFGH456789"), F("unit_year", "Year", "Vehicle", "2026"), F("unit_make", "Make", "Vehicle", "Mockmake"),
  F("unit_model", "Model", "Vehicle", "Trail 1000 XT"), F("condition", "New or Used", "Vehicle", "New"), F("vehicle_type", "Vehicle type", "Vehicle", "UTV"),
  F("engine.ccs", "Engine size (cc)", "Vehicle", "976"), F("odometer", "Odometer", "Vehicle", "3"), F("in_service_date", "In-service date", "Vehicle", "2026-11-02"),
  F("warranty", "Factory warranty remaining", "Vehicle", "12"), F("fuel.type", "Fuel type", "Vehicle", "Gasoline"),
  F("sale_price", "Sale price", "Money", "$21,499.00"), F("amount_financed", "Amount financed", "Money", "$23,410.55"),
  F("finance_term", "Term (months)", "Money", "60"), F("apr", "APR", "Money", "7.99"),
  F("agreed_down_payment", "Down payment", "Money", "$1,000.00", { required: false }), F("max_amount_financed", "Maximum amount financed", "Money", null, { required: false, missing: false }),
  F("buyer_city", "City", "Customer", "Mocktown"), F("buyer_state", "State", "Customer", "WV"), F("buyer_zip", "ZIP", "Customer", "26101"),
];
const pf = (key, label, input, value) => ({ key, label, input, value, crm_value: value, edited: false, was: null, edited_by: null, edited_at: null, crm_changed: false, missing: null });
const parties = {
  locked: false, lock_reason: null, changes: [],
  parties: [
    { party: "Buyer", present: true, in_crm: true, removed: null, business: false, heading: "Pat Example", missing: [],
      fields: [pf("buyer_first_name", "First name", "text", "Pat"), pf("buyer_last_name", "Last name", "text", "Example"), pf("buyer_address", "Address", "text", "1 Test Lane"), pf("buyer_phone", "Phone", "phone", "304-555-0100"), pf("buyer_email", "Email", "email", "pat@example.com")] },
    { party: "Co-Buyer", present: false, in_crm: false, removed: null, business: false, heading: null, missing: [], fields: [pf("cobuyer_first_name", "First name", "text", null)] },
    { party: "Lienholder", present: true, in_crm: true, removed: null, business: true, heading: "Example Credit Union", missing: [],
      fields: [pf("lienholder_name", "Name", "text", "Example Credit Union"), pf("lienholder_address", "Address", "text", "9 Bank St")] },
  ],
};

/** How many times each session has been rated again in this run. */
const ratedAgain = new Map();
/** Sessions not rated yet that Verify, then the first rate, moved on in this run. */
const verifiedNow = new Set();
const ratedNow = new Set();

function sheet(id) {
  const variant = id.startsWith("1") ? "new" : id.startsWith("2") ? "rated" : "prepared";
  const verified = variant !== "new" || verifiedNow.has(id);
  const rated = variant !== "new" || ratedNow.has(id);
  const again = ratedAgain.get(id) ?? 0;
  return {
    session: { id, deal_number: "99901", stock_number: "ST-1234", status: "Open", is_test: true, vehicle: "2026 Mockmake Trail 1000 XT", deal_type: "Finance", vehicle_type_code: "UTV" },
    provider_name: "Mock Provider",
    verification: { state: verified ? "Verified" : "Needs Verification", verified_at: verified ? "2026-11-02T13:00:00Z" : null, verified_by: verified ? "JS" : null },
    rating: rated
      ? { state: "Rated", product_count: 11 + again, out_of_date: false, rated_at: again ? `2026-11-02T14:0${again}:00Z` : "2026-11-02T13:00:05Z", detail: null, providers: [{ name: "Mock Provider", state: "Rated", line: `Mock Provider: Rated, ${11 + again} products.` }] }
      : { state: "Pending", product_count: 0, out_of_date: false, rated_at: null, detail: null, providers: [] },
    rating_differences: null,
    unplaced_offers: [],
    rating_notices: again ? [`Mock notice from rating ${again + 1}.`] : [],
    menu_columns: [{ position: 1, name: "Platinum", template_level: "Highest", level: "Highest" }, { position: 2, name: "Gold", template_level: "Middle", level: "Middle" }, { position: 3, name: "Silver", template_level: "Lowest", level: "Lowest" }],
    menu_template: { name: "UTV menu" }, hidden_slots: [], oem_contracts: [], contracts_panel: null,
    prepared: variant === "prepared" ? { at: "2026-11-02T13:10:00Z", by: "JS" } : null,
    vin_decode: { ok: true }, vin_decode_at: "2026-11-02T12:00:00Z", vin_decode_attempted_at: "2026-11-02T12:00:00Z", vin_decode_error: null,
    duplicate_vin: null, contracts: [], submit_state: "Idle", submit_detail: null, provider_answer: null, not_ready_reason: null,
    day: { time_zone: "America/New_York", today: "2026-11-02", expires_at: "2026-11-03T04:59:59Z", sale_date: "2026-11-02", submit_problem: null, date_line: null, contract_date_lines: [] },
    contract_parties: parties,
    fields, missing: [], ready: true, unmapped_properties: [], edited: [], crm_mismatches: [], crm_warning: null, invalid: [], over_cap_warning: null,
  };
}


const STORES = ["Mock Store, Mocktown", "Second Store, Elsewhere"];
/** The stores' ids, beside their full names. */
export const STORE_IDS = ["5a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "5b000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
/**
 * Every store, as Administration > Stores sees it (fni.ps_stores, migration
 * 0059): the full name, whether it uses PS, and its CRM dealer. The first two
 * are the stores the made-up sessions are at; four start on, and two pairs
 * share a dealer, as on Test.
 */
export const ALL_STORES = [
  { id: STORE_IDS[0], name: STORES[0], dealer: "d1", uses_ps: true },
  { id: STORE_IDS[1], name: STORES[1], dealer: "d2", uses_ps: true },
  { id: "5c000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Mock Powersports, Riverside", dealer: "d3", uses_ps: true },
  { id: "5d000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Mock Powersports, Hilltop", dealer: "d4", uses_ps: true },
  { id: "5e000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Mock Equipment, Riverside", dealer: "d3", uses_ps: false },
  { id: "5f000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Mock Equipment, Hilltop", dealer: "d4", uses_ps: false },
  { id: "50000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Mock Chevrolet", dealer: null, uses_ps: false },
  { id: "51000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Mock Ford", dealer: null, uses_ps: false },
  { id: "52000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Mock Rides", dealer: "d9", uses_ps: false },
];
const CUSTOMERS = [["Pat Example", null], ["Sam Sample", "Jo Sample"], ["Mock Trail Rentals LLC", null]];
export function sessions(n) {
  const states = ["Rated", "Failed", "Pending", "Not Offered"];
  return Array.from({ length: n }, (_, i) => ({
    id: `${(i % 3) + 1}${(i + 1).toString(16).padStart(7, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, deal_number: String(90000 + i), status: "Open", mode: "Finance",
    store_name: STORES[i % 2], store_id: STORE_IDS[i % 2], customer: CUSTOMERS[i % 3][0], co_buyer: CUSTOMERS[i % 3][1],
    year: 2026, make: "Mockmake", model: "Trail 1000 XT", submodel: "Limited Edition", stock_number: `ST-${1000 + i}`,
    created_at: "2026-11-02T13:00:00Z", expires_at: "2026-11-03T04:59:59Z", expired: false, time_zone: "America/New_York",
    rating: { state: states[i % 4], at: "2026-11-02T13:00:05Z", detail: states[i % 4] === "Failed" ? "Mock provider said no." : null,
      failures: states[i % 4] === "Failed" ? [{ provider: "Mock Provider", text: "Mock provider said no.", at: "2026-11-02T13:00:05Z" }] : [] },
  }));
}

/** What the customer's tabs read (fni-session-get): one made-up product, two terms. */
function customerSession(id) {
  const rate = (months, price) => ({
    rate_unique_id: `mock-${months}`, term_months: months, term_miles: null, deductible: 0, deductible_code: null,
    disappearing_deductible: false, dealer_cost: price - 400, provider_markup: 0, offered_price: price, options: [],
    retail_price: price, pricing_rule_id: null, unpriced_reason: null, raw: {},
  });
  return {
    session: {
      id, status: "In Progress", mode: "Staff-Presented", mode_label: "Staff-presented", store_id: "s0", deal_id: null,
      deal_number: "99901", buyer_type: "Individual", buyer_display_name: "Pat Example", cobuyer_type: null, cobuyer_display_name: null,
      vehicle: { year: 2026, make: "Mockmake", model: "Trail 1000 XT", submodel: null, vin: "1ABCD23EFGH456789", condition: "New",
        tecassured_code: "UTV", in_service_date: "2026-11-02", mileage_or_hours: 3, stock_number: "ST-1234" },
      financials: { sale_price: 21499, amount_financed: 23410.55, amortized_principal: 23410.55, interest_rate: 7.99, apr: 7.99, rate_used: 7.99,
        rate_source: "apr", rate_label: "APR", term_months: 60, contract_payment: 474.55, finance_type: "Finance", lienholder_name: "Example Credit Union",
        payment_basis: "tila", has_payment: true, max_amount_financed: null, agreed_down_payment: 1000 },
      discovery: null, expires_at: "2026-11-03T04:59:59Z",
    },
    offer: { rated_at: "2026-11-02T13:00:05Z", product_count: 1, families: [{
      family_code: "MECH", provider_id: "p0", provider_name: "Mock Provider",
      tiers: [{ product_code: "MP", product_name: "Mechanical Protection", product_type: "VSA", rates: [rate(24, 1295), rate(36, 1595)], raw: {}, provider_id: "p0", provider_name: "Mock Provider" }],
    }] },
    offer_status: { state: "Rated", detail: null, attempted_at: "2026-11-02T13:00:05Z" },
    verification: { state: "Verified", verified_at: "2026-11-02T13:00:00Z" },
    catalog: [{ provider_id: "p0", category: "Mechanical", product_code: "MP", display_name: "Mechanical Protection", goal: "Repairs paid for",
      what_it_accomplishes: "Pays for covered repairs.", what_it_covers: "The engine and drivetrain.", coverage_duration: null, what_it_excludes: null,
      deductible_note: null, how_to_use: null, transferable: true, transfer_note: null, future_value_note: null, full_terms_url: null,
      relevance_tags: [], display_order: 1, store_id: null, is_presentable: true }],
    dealer_group_name: "Mock Dealer Group", copy: {},
    catalog_coverage: { offered: 1, matched: 1, copy_pending: [], unmatched: [] },
    selections: [], purchased: [],
    menu_columns: [{ name: "Gold", preset_categories: ["Mechanical"], starting_level: "Middle" }],
    menu_prepared: null, photos: [], photos_cached_at: "2026-11-02T13:00:00Z",
  };
}

/** What a rating changes on Details, as fni-rate-vehicle answers Rate again (_shared/details-offer.ts). */
function offerDetails(id) {
  const s = sheet(id);
  return {
    session_status: s.session.status, rating: s.rating, rating_differences: s.rating_differences, menu_columns: s.menu_columns,
    unplaced_offers: s.unplaced_offers, rating_notices: s.rating_notices, hidden_slots: s.hidden_slots, contracts_panel: s.contracts_panel,
  };
}

export function startMockEdge({ port, delayMs = 0, rows = 6, delays = {} } = {}) {
  // `access` is who is signed in, as the server decides it: an Administrator
  // (every store), or Staff with the stores granted (migration 0058). The
  // list is filtered here the way fni-admin-sessions filters it.
  const state = {
    delayMs, rows, calls: {}, delays, access: { role: "Administrator", storeIds: null },
    // Each store's PS settings, changed by the Stores page's saves.
    stores: ALL_STORES.map((st) => ({ ...st, time_zone: "America/New_York" })),
  };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const fn = u.pathname.split("/").pop();
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const key = `${req.method} ${fn}`;
    state.calls[key] = (state.calls[key] ?? 0) + 1;
    const wait = state.delays[key] ?? state.delayMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const json = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (fn === "fni-admin-sessions") {
      const { role, storeIds } = state.access;
      // Only stores that use PS are offered (fni-admin-sessions).
      const allowed = state.stores.filter((st) => st.uses_ps && (storeIds === null || storeIds.includes(st.id))).map((st) => ({ id: st.id, name: st.name }));
      const section = u.searchParams.get("section");
      if (section === "me") return json(200, { role, email: "test.person@example.com", stores: allowed });
      if (section === "staff") {
        if (role !== "Administrator") return json(403, { error: "Only an administrator can change who sees which stores." });
        return json(200, {
          people: [
            { user_id: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a", email: "test.person@example.com", role: "Administrator", role_granted_by: "claude", store_ids: [] },
            { user_id: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", email: "second.person@example.com", role: "Staff", role_granted_by: "test.person@example.com", store_ids: [STORE_IDS[0]] },
          ],
          stores: state.stores.filter((st) => st.uses_ps).map((st) => ({ id: st.id, name: st.name })).sort((a, b) => a.name.localeCompare(b.name)),
        });
      }
      if (storeIds !== null && storeIds.length === 0) {
        return json(200, { limit: 60, as_of: new Date().toISOString(), role, stores: [], notice: "No stores assigned. Ask an administrator for access.", sessions: [] });
      }
      const rowsFor = sessions(state.rows).filter((r) => storeIds === null || storeIds.includes(r.store_id))
        .sort((a, b) => a.store_name.localeCompare(b.store_name) || Date.parse(b.created_at) - Date.parse(a.created_at));
      return json(200, { limit: 60, as_of: new Date().toISOString(), role, stores: allowed.sort((a, b) => a.name.localeCompare(b.name)), notice: null, sessions: rowsFor });
    }
    // The Stores page's saves: DocuRide PS on or off, or the time zone.
    if (fn === "fni-admin-settings" && req.method === "POST") {
      const body = raw ? JSON.parse(raw) : {};
      if (body.section === "stores") {
        const st = state.stores.find((x) => x.id === body.store_id);
        if (!st) return json(404, { error: "That store does not exist." });
        if (typeof body.uses_ps === "boolean") st.uses_ps = body.uses_ps;
        else st.time_zone = body.time_zone;
        return json(200, { ok: true });
      }
    }
    if (fn === "fni-admin-settings" && u.searchParams.get("section") === "stores") {
      return json(200, {
        time_zones: [{ zone: "America/New_York", label: "Eastern" }, { zone: "America/Chicago", label: "Central" }],
        stores: state.stores.map((st) => ({
          id: st.id, name: st.name, place: null, time_zone: st.time_zone, today: "2026-11-02", uses_ps: st.uses_ps,
          same_dealer: st.dealer ? state.stores.filter((o) => o.id !== st.id && o.dealer === st.dealer).map((o) => o.name) : [],
        })).sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    if (fn === "fni-admin-settings") return json(200, { stores: STORES.map((name, i) => ({ id: `s${i}`, name })), rules: [], scope: "all" });
    if (fn === "fni-session-verify" && req.method === "GET") return json(200, sheet(u.searchParams.get("session_id")));
    if (fn === "fni-session-verify") {
      // Each action answers with the whole sheet, and its words beside it.
      const body = raw ? JSON.parse(raw) : {};
      if (body.action === "verify") {
        verifiedNow.add(body.session_id);
        return json(200, { ...sheet(body.session_id), verified: true });
      }
      if (body.action === "refresh") return json(200, { ...sheet(body.session_id), refreshed: true, changed_inputs: [] });
      return json(200, { ...sheet(body.session_id), changed_inputs: [] });
    }
    if (fn === "fni-dx1-check") return json(200, { status: "Nothing to check", blocking: [], warnings: [] });
    // The layout deal: seven rows, four columns, the longest names (scripts/layout-check.mjs).
    const sid = u.searchParams.get("session_id");
    if (fn === "fni-menu-prepare" && req.method === "GET") return json(200, preparePayload(sid));
    if (fn === "fni-session-get" && sid === LAYOUT_SESSION) return json(200, { ...customerSession(sid), ...menuParts(), offer: { ...customerSession(sid).offer, families: menuParts().families, product_count: 15 } });
    if (fn === "fni-session-get") return json(200, customerSession(u.searchParams.get("session_id")));
    if (fn === "fni-session-save") return json(200, { ok: true });
    if (fn === "fni-acknowledgment") return json(200, { ok: true, pdf_base64: null });
    if (fn === "fni-rate-vehicle") {
      const body = raw ? JSON.parse(raw) : {};
      if (body.rate_again === true) {
        ratedAgain.set(body.session_id, (ratedAgain.get(body.session_id) ?? 0) + 1);
        const d = offerDetails(body.session_id);
        return json(200, { session_id: body.session_id, outcome: "rated", product_count: d.rating.product_count, lines: [], details: d });
      }
      // The first rate, after Verify: with what it changed on Details.
      ratedNow.add(body.session_id);
      return json(200, { session_id: body.session_id, status: "Open", product_count: 11, details: offerDetails(body.session_id) });
    }
    return json(404, { error: "Not served by the mock." });
  });
  return new Promise((r) => server.listen(port, () => r({ state, close: () => server.close() })));
}
