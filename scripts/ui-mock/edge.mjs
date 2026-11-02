// scripts/ui-mock/edge.mjs: a stand-in for the Edge Functions the screens read.
//
// For the browser checks in scripts/ only. Made-up deals and sessions, no real
// data, nothing reaches Supabase. Session ids starting 1 are not rated yet,
// 2 rated and not prepared, 3 prepared. `delayMs` slows every answer, to watch
// the busy state; `calls` counts each function's requests.

import http from "node:http";

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

function sheet(id) {
  const variant = id.startsWith("1") ? "new" : id.startsWith("2") ? "rated" : "prepared";
  const verified = variant !== "new";
  return {
    session: { id, deal_number: "99901", stock_number: "ST-1234", status: "Open", is_test: true, vehicle: "2026 Mockmake Trail 1000 XT", deal_type: "Finance", vehicle_type_code: "UTV" },
    provider_name: "Mock Provider",
    verification: { state: verified ? "Verified" : "Needs Verification", verified_at: verified ? "2026-11-02T13:00:00Z" : null, verified_by: verified ? "JS" : null },
    rating: verified
      ? { state: "Rated", product_count: 11, out_of_date: false, rated_at: "2026-11-02T13:00:05Z", detail: null, providers: [{ name: "Mock Provider", state: "Rated", line: "Mock Provider: Rated, 11 products." }] }
      : { state: "Pending", product_count: 0, out_of_date: false, rated_at: null, detail: null, providers: [] },
    rating_differences: null,
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
export function sessions(n) {
  const states = ["Rated", "Failed", "Pending", "Not Offered"];
  return Array.from({ length: n }, (_, i) => ({
    id: `${(i % 3) + 1}${(i + 1).toString(16).padStart(7, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, deal_number: String(90000 + i), status: "Open", mode: "Finance",
    store_name: STORES[i % 2], year: 2026, make: "Mockmake", model: "Trail 1000 XT", submodel: "Limited Edition", stock_number: `ST-${1000 + i}`,
    created_at: "2026-11-02T13:00:00Z", expires_at: "2026-11-03T04:59:59Z", expired: false, time_zone: "America/New_York",
    rating: { state: states[i % 4], at: "2026-11-02T13:00:05Z", detail: states[i % 4] === "Failed" ? "Mock provider said no." : null,
      failures: states[i % 4] === "Failed" ? [{ provider: "Mock Provider", text: "Mock provider said no.", at: "2026-11-02T13:00:05Z" }] : [] },
  }));
}

export function startMockEdge({ port, delayMs = 0, rows = 6 } = {}) {
  const state = { delayMs, rows, calls: {} };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const fn = u.pathname.split("/").pop();
    for await (const _ of req) { /* drain */ }
    const key = `${req.method} ${fn}`;
    state.calls[key] = (state.calls[key] ?? 0) + 1;
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    const json = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (fn === "fni-admin-sessions") return json(200, { limit: 60, as_of: new Date().toISOString(), sessions: sessions(state.rows) });
    if (fn === "fni-admin-settings" && u.searchParams.get("section") === "stores") {
      return json(200, {
        time_zones: [{ zone: "America/New_York", label: "Eastern" }],
        stores: STORES.map((name, i) => ({ id: `s${i}`, name, place: null, time_zone: "America/New_York", today: "2026-11-02" })),
      });
    }
    if (fn === "fni-admin-settings") return json(200, { stores: STORES.map((name, i) => ({ id: `s${i}`, name })), rules: [], scope: "all" });
    if (fn === "fni-session-verify" && req.method === "GET") return json(200, sheet(u.searchParams.get("session_id")));
    if (fn === "fni-session-verify") return json(200, { ok: true });
    if (fn === "fni-dx1-check") return json(200, { status: "Nothing to check", blocking: [], warnings: [] });
    if (fn === "fni-rate-vehicle") return json(200, { product_count: 11, outcome: "unchanged", lines: [] });
    return json(404, { error: "Not served by the mock." });
  });
  return new Promise((r) => server.listen(port, () => r({ state, close: () => server.close() })));
}
