// admin.html is a single no-framework page. These helpers load it into jsdom
// with a stubbed supabase-js client, so the panels can be driven without
// touching Supabase — the client only records what the page asked for.

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

export const HTML = readFileSync(new URL("../admin.html", import.meta.url), "utf8");
export const EMAIL = "ops@docuride.test";

/** Price rows the stub hands back for rr_form_prices, already in (section, form_id) order. */
export const PRICES = [
  { form_id: "0122",  description: "Retail Installment Contract", transaction_fee: "3.22", section: "A", updated_at: "2026-08-01T12:00:00Z", updated_by: EMAIL },
  { form_id: "8721",  description: "Odometer Disclosure",         transaction_fee: "0.41", section: "A", updated_at: "2026-08-01T12:00:00Z", updated_by: EMAIL },
  { form_id: "IDA-1", description: "Idaho Title Application",     transaction_fee: "1.05", section: "B", updated_at: null, updated_by: null },
];

/** A chainable stand-in for supabase-js's PostgrestFilterBuilder. */
function stubClient(calls, ctl){
  const from = (table) => {
    const rec = { table, ops: [], patch: null, row: null, eq: {} };
    calls.push(rec);
    const b = {
      select(cols){ rec.ops.push("select"); rec.select = cols; return b; },
      order(col, opt){ rec.ops.push("order"); (rec.order ??= []).push([col, opt]); return b; },
      eq(col, val){ rec.ops.push("eq"); rec.eq[col] = val; return b; },
      update(patch){ rec.ops.push("update"); rec.patch = patch; return b; },
      insert(row){ rec.ops.push("insert"); rec.row = row; return b; },
      delete(){ rec.ops.push("delete"); return b; },
      maybeSingle(){ rec.ops.push("maybeSingle"); return b; },
      limit(){ rec.ops.push("limit"); return b; },
      then(res, rej){ return Promise.resolve(reply(rec, ctl)).then(res, rej); },
    };
    return b;
  };
  return {
    from,
    auth: {
      getSession: async () => ({ data: { session: { access_token: "t", user: { email: EMAIL } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
      signOut: async () => ({}),
      updateUser: async () => ({}),
      resetPasswordForEmail: async () => ({}),
      signInWithPassword: async () => ({}),
    },
  };
}

function reply(rec, ctl){
  if (rec.ops.some(o => o === "update" || o === "insert" || o === "delete")){
    // ctl.failNext lets a test make one write fail the way RLS would.
    if (ctl.failNext){ ctl.failNext = false; return { data: null, error: { message: "permission denied for table rr_form_prices" } }; }
    return { data: null, error: null };
  }
  switch (rec.table){
    case "rr_report_settings":
      return { data: /minimum/.test(rec.select ?? "") ? { minimum_monthly_fee: "375.00" } : { review_emails: [] }, error: null };
    case "rr_form_prices":      return { data: PRICES.map(r => ({ ...r })), error: null };
    case "rr_report_approvals": return { data: null, error: null };
    default:                    return { data: [], error: null };
  }
}

// jsdom builds objects in its own realm, so deepStrictEqual sees a different
// Object prototype. Compare the values, not the realm.
export const plain = (v) => JSON.parse(JSON.stringify(v));

export const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

export async function loadAdmin(){
  const calls = [];
  const ctl = { failNext: false };
  const dom = new JSDOM(HTML, {
    url: "https://docuride.test/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w){
      w.supabase = { createClient: () => stubClient(calls, ctl) };
      // admin-users is the only fetch the page makes on boot.
      w.fetch = async () => ({ ok: true, status: 200, statusText: "OK",
        json: async () => ({ users: [], tenants: [], stores: [] }) });
      w.confirm = () => true;
    },
  });
  await flush();
  return { dom, w: dom.window, calls, ctl };
}
