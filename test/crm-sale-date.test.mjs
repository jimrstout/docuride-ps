// The CRM sale date is the only sale date (2026-10-30, migration 0044). The
// DocuRide record's Sale_Date is changed in the CRM only; PS keeps the last
// value it read, to notice changes, and records a change in one place with
// one System event and the month rule. Replaces the Renew for Today tests:
// Renew, the staff sale date and the planned sale date are retired. Mock data
// only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CRM_MODULE,
  crmSaleDate,
  freshSaleDate,
  recordCrmSaleDate,
} from "../supabase/functions/_shared/crm-sale-date.ts";
import {
  RATING_OUT_OF_DATE,
  renewedBy,
  staleRatingProblem,
  SYSTEM,
} from "../supabase/functions/_shared/sale-date.ts";
import * as planner from "../apps/ownership-planner/lib/submit-check.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

/** A fake client: the price sheets it is asked for, and every RPC it is sent. */
function fakeSupabase({ sheets = [], answer = "Changed", old = null, sheetsFail = false } = {}) {
  const calls = [];
  const client = {
    schema: () => ({
      from: () => {
        const q = {
          select: () => q,
          eq: () => q,
          then: (res) => res(sheetsFail ? { data: null, error: { message: "nope" } } : { data: sheets, error: null }),
        };
        return q;
      },
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        return { data: [{ outcome: answer, old_sale_date: old, new_sale_date: args.p_new }], error: null };
      },
    }),
  };
  return { client, calls };
}

const SESSION = { id: "00000000-0000-4000-8000-000000000001", tenant_id: "00000000-0000-4000-8000-0000000000aa", zoho_deal_id: "4742556000000000001", sale_date: "2026-09-26" };

test("the CRM's Sale_Date is read as a calendar day", () => {
  assert.equal(crmSaleDate({ Sale_Date: "2026-10-30" }), "2026-10-30");
  assert.equal(crmSaleDate({ Sale_Date: null }), null);
  assert.equal(crmSaleDate(null), null);
  assert.equal(CRM_MODULE, "DocuRide");
});

test("an unchanged date sends nothing; a changed one goes to the one recorder with the month rule", async () => {
  const same = fakeSupabase();
  assert.deepEqual(await recordCrmSaleDate(same.client, SESSION, "2026-09-26"), { outcome: "Unchanged", sale: "2026-09-26" });
  assert.equal(same.calls.length, 0);

  // Into another month: a re-rate.
  const cross = fakeSupabase();
  assert.deepEqual(await recordCrmSaleDate(cross.client, SESSION, "2026-10-30"), { outcome: "Changed", sale: "2026-10-30" });
  assert.deepEqual(cross.calls, [{ fn: "record_crm_sale_date", args: { p_session: SESSION.id, p_expected: "2026-09-26", p_new: "2026-10-30", p_rerate: true } }]);

  // Within the month: the rating stands.
  const within = fakeSupabase();
  await recordCrmSaleDate(within.client, SESSION, "2026-09-28");
  assert.equal(within.calls[0].args.p_rerate, false);

  // Across a price sheet's first day, or with the sheets unreadable: a re-rate.
  const sheet = fakeSupabase({ sheets: [{ effective_from: "2026-09-27", effective_to: null }] });
  await recordCrmSaleDate(sheet.client, SESSION, "2026-09-28");
  assert.equal(sheet.calls[0].args.p_rerate, true);
  const unread = fakeSupabase({ sheetsFail: true });
  await recordCrmSaleDate(unread.client, SESSION, "2026-09-28");
  assert.equal(unread.calls[0].args.p_rerate, true);

  // Cleared in the CRM: recorded as no sale date, and a re-rate.
  const cleared = fakeSupabase();
  await recordCrmSaleDate(cleared.client, SESSION, null);
  assert.deepEqual([cleared.calls[0].args.p_new, cleared.calls[0].args.p_rerate], [null, true]);

  // Another writer got there first: theirs stands.
  const raced = fakeSupabase({ answer: "Changed meanwhile", old: "2026-10-01" });
  assert.deepEqual(await recordCrmSaleDate(raced.client, SESSION, "2026-10-30"), { outcome: "Changed meanwhile", sale: "2026-10-01" });
});

test("a fresh read uses the CRM; a CRM that does not answer leaves the copy and says so", async () => {
  const ok = fakeSupabase();
  const got = await freshSaleDate(ok.client, SESSION, 1000, async (module, id) => {
    assert.deepEqual([module, id], ["DocuRide", SESSION.zoho_deal_id]);
    return { Sale_Date: "2026-10-30" };
  });
  assert.deepEqual(got, { sale: "2026-10-30", fresh: true, outcome: "Changed", problem: null });

  const down = await freshSaleDate(fakeSupabase().client, SESSION, 1000, async () => { throw new Error("down"); });
  assert.deepEqual(down, { sale: "2026-09-26", fresh: false, outcome: null, problem: "The sale date could not be read from the CRM just now." });

  const slow = await freshSaleDate(fakeSupabase().client, SESSION, 20, () => new Promise((r) => setTimeout(() => r({ Sale_Date: "2026-10-30" }), 200)));
  assert.equal(slow.fresh, false);

  const none = await freshSaleDate(fakeSupabase().client, { ...SESSION, zoho_deal_id: null }, 1000, async () => assert.fail("not read"));
  assert.equal(none.fresh, false);
  assert.equal(none.sale, "2026-09-26");
});

test("read fresh by zoho-sync, Details, rating and Submit; Submit refuses without it", () => {
  const sync = read("supabase/functions/zoho-sync/index.ts");
  assert.match(sync, /await recordSaleDate\(head\.zoho_id, record as unknown as Record<string, unknown>\);/);
  assert.match(sync, /await recordCrmSaleDate\(supabase, s, crmSaleDate\(record\)\);/);
  // After the deals mirror and the folders, and a failure fails the item.
  assert.ok(sync.indexOf("await recordSaleDate(head.zoho_id") > sync.indexOf('sbUpsert("deals"'));
  assert.ok(sync.indexOf("await recordSaleDate(head.zoho_id") < sync.indexOf("await markProcessed(ids);\n        synced++;"));

  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /const crmRead = await freshSaleDate\(supabase, loaded as unknown as \{ id: string \}\);/);
  const refresh = verify.slice(verify.indexOf("async function refresh("), verify.indexOf("async function verify("));
  assert.match(refresh, /await recordCrmSaleDate\(supabase, s as unknown as \{ id: string \}, crmSaleDate\(record as unknown as Record<string, unknown>\)\);/);
  assert.ok(refresh.indexOf("recordCrmSaleDate(") < refresh.indexOf(".update(patch)"));

  const rate = read("supabase/functions/fni-rate-vehicle/index.ts");
  assert.match(rate, /const crmRead = await freshSaleDate\(supabase, sess as unknown as SaleDateSession\);/);
  assert.ok(rate.indexOf("const crmRead = await freshSaleDate(") < rate.indexOf("const rateSource = applyStaffEdits("));

  const start = read("supabase/functions/fni-session-start/index.ts");
  assert.match(start, /const \{ sale \} = await recordCrmSaleDate\(/);

  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /return await refuse\(503, \{ error: `\$\{crmRead\.problem \?\? "The sale date could not be read from the CRM just now\."\} Nothing was sent\. Try again in a moment\.` \}\);/);
  assert.match(submit, /contract_sale_date: dates\.sale,/);
});

test("nothing in PS writes the sale date but the recorder and a new session", () => {
  for (const f of [
    "supabase/functions/fni-session-verify/index.ts",
    "supabase/functions/fni-session-start/index.ts",
    "supabase/functions/fni-admin-sessions/index.ts",
    "supabase/functions/fni-rate-vehicle/index.ts",
    "supabase/functions/fni-contract-submit/index.ts",
    "supabase/functions/zoho-sync/index.ts",
  ]) {
    const src = read(f);
    assert.doesNotMatch(src, /\.update\(\{[^}]*\bsale_date\b/, f);
    assert.doesNotMatch(src, /staff_edits[^;]*sale_date|movedSaleDateEdit|renewDateMoves|planned_sale_date:/, f);
  }
  // And no PS code writes the CRM's Sale_Date.
  for (const f of ["supabase/functions/_shared/crm-sale-date.ts", "supabase/functions/zoho-sync/index.ts"]) {
    assert.doesNotMatch(read(f), /updateRecord|upsertRecord|method: "PUT"/, f);
  }
});

test("logs carry ids and outcomes only, never a date", () => {
  const f = read("supabase/functions/_shared/crm-sale-date.ts");
  for (const m of f.matchAll(/console\.\w+\("[^"]*",([^;]*)\);/g)) {
    assert.doesNotMatch(m[1], /\bsale\b|\bnext\b|\bold\b|\brecord\b|Sale_Date/, m[1]);
  }
});

test("initials or System, as every action records them", () => {
  assert.equal(SYSTEM, "System");
  assert.equal(renewedBy("js"), "JS");
  assert.equal(renewedBy(""), SYSTEM);
  assert.equal(renewedBy("Sample Staff"), SYSTEM);
  assert.equal(renewedBy("ops@docuride.test"), SYSTEM);
});

test("a sale date moved into another month makes the rating out of date, and Submit then needs a re-rate", () => {
  const TODAY = "2026-10-28";
  assert.equal(staleRatingProblem({ out_of_date: true, request_payload: { saleDate: TODAY } }, TODAY), RATING_OUT_OF_DATE);
  assert.match(
    staleRatingProblem({ out_of_date: false, request_payload: { saleDate: "2026-09-30" } }, "2026-10-01"),
    /rated with a sale date of 30 Sep 2026, and its sale date is now 1 Oct 2026, in another month/
  );
  assert.equal(staleRatingProblem({ out_of_date: false, request_payload: { saleDate: "2026-10-27" } }, TODAY), null);
  assert.equal(staleRatingProblem({ out_of_date: false, request_payload: {} }, TODAY), null);

  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /const stale = staleRatingProblem\(ratedOffer, dates\.sale\);\s*if \(stale\) \{\s*if \(pricePolicy\(session, credentials\.api_base_url\) !== "Test at maximum"\) \{\s*return await refuse\(400, \{ error: stale \}\);/);
  assert.ok(submit.indexOf("const stale = ") > submit.indexOf("const dayProblem"));
  assert.ok(submit.indexOf("const stale = ") < submit.indexOf("Step 4: Cut the quote down"));

  assert.equal(planner.RATING_OUT_OF_DATE, RATING_OUT_OF_DATE);
  assert.equal(planner.submitBlock({ day: { submit_problem: null }, rating: { out_of_date: true } }), RATING_OUT_OF_DATE);
  assert.equal(planner.submitBlock({ day: { submit_problem: "Not today." }, rating: { out_of_date: true } }), "Not today.");
});
