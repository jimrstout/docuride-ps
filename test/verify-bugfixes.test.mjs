// test/verify-bugfixes.test.mjs
//
// The four faults found on deal 13759's Verify screen, each with the case that
// would have caught it.
//
//   1. Save changes refused the whole form over React's own hidden $ACTION_ID.
//   2. Term and APR read Missing on a deal whose customer screen said
//      "6.99% · 60 months", because the sheet and the planner read different
//      columns -- and so did the TecAssured rate request.
//   3. The help text under the three finance figures explained cash deals on a
//      financed deal.
//   4. Refusal messages travelled in the URL query string.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RATING_INPUT_NAMES,
  isRatingInputName,
  ratingInputsFrom,
} from "../apps/ownership-planner/lib/verify-fields.ts";
import {
  decodeVerifyFlash,
  encodeVerifyFlash,
  flashMessage,
  VERIFY_FLASH_COOKIE,
  VERIFY_FLASH_OPTIONS,
} from "../apps/ownership-planner/lib/verify-flash.ts";
import { EDIT_TARGETS } from "../supabase/functions/_shared/staff-edits.ts";
import { financeFigures } from "../supabase/functions/_shared/finance-basis.ts";
import { buildVerification } from "../supabase/functions/_shared/verification.ts";
import { buildRateRequest } from "../supabase/functions/_shared/rate-request.ts";
import { crmRatingFields } from "../supabase/functions/_shared/crm-fields.ts";

/** A slice of a file, refusing to guess when either marker is absent. */
function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `start marker not found: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `end marker not found after start: ${endMarker}`);
  return text.slice(start, end);
}

const ACTIONS = readFileSync(
  new URL("../apps/ownership-planner/app/console-actions.ts", import.meta.url),
  "utf8"
);

/** Deal 13759 as fni.sessions holds it. Financed, and TILA never calculated. */
const DEAL_13759 = {
  deal_number: "13759",
  stock_number: null,
  finance_type: "Loan",
  sale_date: "2026-09-26",
  vin: "3JBACAX43TE001930",
  unit_year: 2026,
  unit_make: "Can-Am",
  unit_model: "Commander MAX XT 1000R",
  condition: "New",
  vehicle_type_code: "UTV",
  odometer: 1,
  in_service_date: "2026-09-26",
  sale_price: 24999,
  amount_financed: 27547.64,
  // The columns fni-session-start fills from TILA. Empty on this deal: TILA has
  // not been run, which is normal before the lender's figures come back.
  finance_term: null,
  apr: null,
  // The columns that actually carry the loan.
  interest_rate: 6.99,
  finance_term_total: 60,
  tila_amount_financed: null,
  lienholder_name: "Roadrunner Financial LLC.",
  buyer_city: "Big Springs",
  buyer_state: "WV",
  buyer_zip: "26137",
  vehicle_properties: null,
  vin_decode: null,
};

/** The UTV list TecAssured returns for Dealer ID 3-306. */
const UTV_REQUIRED = [
  "vin", "fuel.type", "year", "make", "model", "new.used", "engine.ccs",
  "finance.type", "finance.amount", "finance.apr", "finance.term", "odometer",
  "price", "sale.date", "inservice.date", "Warranty", "postal.code",
];

const field = (sheet, key) => sheet.fields.find((f) => f.key === key);

// ─── 1. A field that is not a rating input must never block a save ───────────

test("React's hidden $ACTION_ID field is not treated as an edit", () => {
  // The exact shape of the form that failed.
  const form = [
    ["$ACTION_ID_401dfd6ba1f2b4e0c7a09f2f5f4f1a2b3c4d5e6f", "1"],
    ["session_id", "a2a9bb77-afa2-4c44-b917-38dcd1a5e74e"],
    ["checker_name", "Jim Stout"],
    ["odometer", "12"],
    ["warranty", "24"],
  ];

  const entries = ratingInputsFrom(form);

  assert.deepEqual(entries, { odometer: "12", warranty: "24" });
  assert.ok(!("$ACTION_ID_401dfd6ba1f2b4e0c7a09f2f5f4f1a2b3c4d5e6f" in entries));
  assert.ok(!("session_id" in entries), "the address is not a value on the deal");
  assert.ok(!("checker_name" in entries), "who is typing is not a value on the deal");
});

test("any field starting with $ is ignored, whatever the framework calls it next", () => {
  assert.equal(isRatingInputName("$ACTION_ID_abc"), false);
  assert.equal(isRatingInputName("$ACTION_REF_1"), false);
  assert.equal(isRatingInputName("$something_new_react_adds"), false);
  assert.equal(isRatingInputName("odometer"), true);
});

test("an unknown field is dropped rather than forwarded", () => {
  // The allow-list is the real protection: the $ test alone would have let this
  // through, and it would have refused the save the same way.
  const entries = ratingInputsFrom([
    ["odometer", "12"],
    ["some_future_hidden_input", "x"],
    ["buyer_name", "should not be editable here"],
  ]);
  assert.deepEqual(entries, { odometer: "12" });
});

test("a blank box is still sent, because that is how a value is put back", () => {
  assert.deepEqual(ratingInputsFrom([["odometer", ""]]), { odometer: "" });
});

test("the console's field list matches EDIT_TARGETS on the Deno side", () => {
  // The Next build cannot import from supabase/functions/_shared, so this test
  // is what stops the two lists drifting. Same reasoning as lib/money.ts.
  assert.deepEqual(
    [...RATING_INPUT_NAMES].sort(),
    Object.keys(EDIT_TARGETS).sort()
  );
});

test("Deal # and Stock # are not in the list, because they are not rating inputs", () => {
  assert.ok(!RATING_INPUT_NAMES.includes("deal_number"));
  assert.ok(!RATING_INPUT_NAMES.includes("stock_number"));
});

// ─── 2. One source for the term, the rate and the lender ────────────────────

test("deal 13759 resolves to 60 months at 6.99% with a lender", () => {
  const fig = financeFigures(DEAL_13759);
  assert.equal(fig.financed, true);
  assert.equal(fig.termMonths, 60);
  assert.equal(fig.ratePercent, 6.99);
  assert.equal(fig.rateSource, "interest_rate");
  assert.equal(fig.rateLabel, "Interest rate");
  assert.equal(fig.lenderName, "Roadrunner Financial LLC.");
});

test("the Verify sheet shows Term and APR from CRM, not as Missing", () => {
  const sheet = buildVerification(DEAL_13759, UTV_REQUIRED);

  const term = field(sheet, "finance_term");
  assert.equal(term.value, "60", "the term the planner shows");
  assert.equal(term.source, "CRM");
  assert.equal(term.missing, false);
  assert.equal(term.editable, true);

  const apr = field(sheet, "apr");
  assert.equal(apr.value, "6.99%");
  assert.equal(apr.source, "CRM");
  assert.equal(apr.missing, false);
  assert.equal(apr.editable, true);

  assert.deepEqual(
    sheet.missing.map((f) => f.key).sort(),
    ["engine.ccs", "fuel.type", "warranty"],
    "only the three fields no system carries are left"
  );
});

test("the Lender is shown, from the field the planner reads", () => {
  const sheet = buildVerification(DEAL_13759, UTV_REQUIRED);
  const lender = field(sheet, "lender");
  assert.equal(lender.value, "Roadrunner Financial LLC.");
  assert.equal(lender.source, "CRM");
  assert.equal(lender.group, "Deal");
  assert.equal(lender.editable, false, "deal type is the editable field, not this");
  assert.equal(lender.required, false, "TecAssured never asks for it");
});

test("a change of lender does not invalidate a verification", () => {
  // It is not a TecAssured rating input, so it is not in the comparison the
  // refresh gate makes. Deal # and Stock # are out for the same reason.
  const sheet = buildVerification(DEAL_13759, UTV_REQUIRED);
  assert.equal(field(sheet, "lender").provider_property, null);
});

test("APR says which rate it is showing", () => {
  const onInterest = buildVerification(DEAL_13759, UTV_REQUIRED);
  assert.match(field(onInterest, "apr").note, /Interest rate on this deal/);

  // Once TILA has run, the APR is the figure that reproduces the contract.
  const withTila = buildVerification(
    { ...DEAL_13759, apr: 8.5165, tila_amount_financed: 13930.94 },
    UTV_REQUIRED
  );
  assert.equal(field(withTila, "apr").value, "8.5165%");
  assert.match(field(withTila, "apr").note, /Annual percentage rate on this deal/);
});

test("the TecAssured rate request carries the same term and rate as the screen", () => {
  // This is the half that would still have failed. The sheet could say ready and
  // the provider refuse the rate for missing finance.term.
  const required = UTV_REQUIRED.map((name) => ({ name }));
  const { request, missing } = buildRateRequest(
    required,
    { ...DEAL_13759, vehicle_properties: { "engine.ccs": "976", warranty: "24" } },
    { dealerCode: "3-306", vtype: "UTV" }
  );

  assert.deepEqual(missing, [], "nothing TecAssured asked for is unanswered");
  assert.equal(request.financeTerm, "60");
  assert.equal(request.financeApr, "6.99");
  assert.equal(request.financeType, "Loan");

  const prop = (n) => request.properties.find((p) => p.name === n)?.value;
  assert.equal(prop("finance.term"), "60", "both halves of the request agree");
  assert.equal(prop("finance.apr"), "6.99");
});

test("an edit to the Term lands where the sheet reads it back", () => {
  // The trap: EDIT_TARGETS used to write finance_term, which the resolver no
  // longer prefers, so a saved edit would have been invisible on the screen that
  // accepted it.
  assert.equal(EDIT_TARGETS.finance_term.column, "finance_term_total");

  const sheet = buildVerification(DEAL_13759, UTV_REQUIRED, {
    finance_term: {
      value: "48",
      original: "60",
      original_source: "CRM",
      edited_by: "Jim Stout",
      edited_at: "2026-09-27T12:00:00Z",
    },
  });
  const term = field(sheet, "finance_term");
  assert.equal(term.value, "48", "the edit is in force");
  assert.equal(term.source, "Edited by Staff");
  assert.equal(term.original, "60");
  assert.equal(term.differs_from_crm, true);
  assert.match(sheet.crm_warning, /Term \(months\)/);
});

test("an edited APR wins over the CRM interest rate", () => {
  const sheet = buildVerification(DEAL_13759, UTV_REQUIRED, {
    apr: {
      value: "7.5",
      original: "6.99%",
      original_source: "CRM",
      edited_by: "Jim Stout",
      edited_at: "2026-09-27T12:00:00Z",
    },
  });
  assert.equal(field(sheet, "apr").value, "7.5%");
  assert.equal(field(sheet, "apr").differs_from_crm, true);
});

test("a cash deal still reads zero, and says no lender", () => {
  // Deal 14132: no lienholder, and an amount_financed left over from an earlier
  // draft that must never reach the provider.
  const cash = {
    ...DEAL_13759,
    finance_type: "Cash",
    lienholder_name: null,
    interest_rate: 0,
    finance_term_total: 0,
    amount_financed: 19764.64,
  };
  const sheet = buildVerification(cash, UTV_REQUIRED);
  assert.equal(field(sheet, "finance_term").value, "0");
  assert.equal(field(sheet, "apr").value, "0%");
  assert.equal(field(sheet, "amount_financed").value, "$0.00");
  assert.equal(field(sheet, "lender").value, "None (cash deal)");
  assert.equal(field(sheet, "finance_term").editable, false);
});

test("changing the deal type to Finance opens the finance figures", () => {
  // resolvePaymentBasis decides cash from the lienholder. On this screen deal
  // type is the authority, so a deal corrected to Finance before a lienholder is
  // attached must not still read zero.
  const sheet = buildVerification(
    { ...DEAL_13759, finance_type: "Cash", lienholder_name: null },
    UTV_REQUIRED,
    {
      deal_type: {
        value: "Finance",
        original: "Cash",
        original_source: "CRM",
        edited_by: "Jim Stout",
        edited_at: "2026-09-27T12:00:00Z",
      },
    }
  );
  assert.equal(field(sheet, "finance_term").editable, true);
  assert.equal(field(sheet, "finance_term").value, "60", "the term is read, not zeroed");
  assert.equal(field(sheet, "apr").value, "6.99%");
});

test("a refresh from CRM refreshes the columns the sheet now reads", () => {
  // Otherwise Refresh would re-pull the deal and still show yesterday's term.
  const patch = crmRatingFields({
    Name: "13759",
    Sold_1_VIN: "3JBACAX43TE001930",
    Lienholder_Name: "Roadrunner Financial LLC.",
    Interest_Rate: "6.99",
    Term_Months: "60",
    TILA_Amount_Financed: "",
    TILA_Pmt1_Count: "59",
    TILA_Pmt2_Count: "1",
    DC_Sold_1_Balance_Due: "27547.64",
  });

  assert.equal(patch.interest_rate, 6.99);
  assert.equal(patch.finance_term_total, 60);
  assert.equal(patch.lienholder_name, "Roadrunner Financial LLC.");
  assert.equal(patch.finance_type, "Loan");
});

test("with no Term_Months the term is the TILA payment counts added up", () => {
  const patch = crmRatingFields({
    Lienholder_Name: "Roadrunner Financial LLC.",
    TILA_Pmt1_Count: "59",
    TILA_Pmt2_Count: "1",
  });
  assert.equal(patch.finance_term_total, 60, "59 + 1, the way the contract reads");
});

// ─── 3. The cash-deal help text belongs on cash deals ───────────────────────

test("the cash note is not shown on a financed deal", () => {
  const sheet = buildVerification(DEAL_13759, UTV_REQUIRED);
  for (const key of ["amount_financed", "finance_term", "apr"]) {
    const note = field(sheet, key).note ?? "";
    assert.ok(
      !/cash deal/i.test(note),
      `${key} explains cash deals on a financed deal: ${note}`
    );
  }
});

test("the cash note is shown on a cash deal", () => {
  const sheet = buildVerification(
    { ...DEAL_13759, finance_type: "Cash", lienholder_name: null },
    UTV_REQUIRED
  );
  for (const key of ["amount_financed", "finance_term", "apr"]) {
    assert.match(field(sheet, key).note, /cash deal/i, key);
  }
});

test("on a Lease the three finance figures are editable", () => {
  const sheet = buildVerification({ ...DEAL_13759, finance_type: "Lease" }, UTV_REQUIRED);
  for (const key of ["amount_financed", "finance_term", "apr"]) {
    assert.equal(field(sheet, key).editable, true, key);
    assert.ok(!/cash deal/i.test(field(sheet, key).note ?? ""), key);
  }
});

// ─── 4. Errors on the page, not in the URL ──────────────────────────────────

test("a refusal round-trips through the cookie", () => {
  const message = 'TecAssured refused the rate: " Missing displacement."';
  const flash = decodeVerifyFlash(encodeVerifyFlash("refused", message));
  assert.equal(flash.code, "refused");
  assert.equal(flash.detail, message);
  assert.deepEqual(flashMessage(flash), { tone: "bad", text: message });
});

test("a long provider message still fits in one cookie", () => {
  const long = "x".repeat(5000);
  const encoded = encodeVerifyFlash("refused", long);
  assert.ok(encoded.length < 4000, `cookie would be ${encoded.length} bytes`);
  assert.equal(decodeVerifyFlash(encoded).detail.length, 600);
});

test("a missing or damaged cookie shows nothing rather than throwing", () => {
  assert.equal(decodeVerifyFlash(undefined), null);
  assert.equal(decodeVerifyFlash(""), null);
  assert.equal(decodeVerifyFlash("not json"), null);
  assert.equal(decodeVerifyFlash(encodeURIComponent('{"d":"no code"}')), null);
  assert.equal(flashMessage(null), null);
  assert.equal(flashMessage({ code: "made up", detail: null }), null);
});

test("every code an action can set has wording", () => {
  for (const code of [
    "refused", "saved", "decoded", "refreshed", "needname",
    "who", "whocleared", "discarded", "voided", "cleared",
  ]) {
    assert.ok(flashMessage({ code, detail: "C-1" }), `no wording for ${code}`);
  }
});

test("the flash cookie is not readable by script and expires on its own", () => {
  assert.equal(VERIFY_FLASH_OPTIONS.httpOnly, true);
  assert.equal(VERIFY_FLASH_OPTIONS.secure, true);
  assert.ok(VERIFY_FLASH_OPTIONS.maxAge <= 60, "a stale message must not reappear");
  assert.equal(VERIFY_FLASH_COOKIE.startsWith("docuride_"), true);
});

test("no verify action puts a message in the URL", () => {
  // The whole point. A session link is meant to be shareable; a provider refusal
  // is not part of it.
  assert.ok(
    !/\/verify\/\$\{sessionId\}\?/.test(ACTIONS),
    "a verify redirect still carries a query string"
  );
  assert.ok(
    !/refused[=:]\s*message/.test(ACTIONS.replace(/"refused", message/g, "")),
    "a refusal is still being passed as a URL parameter"
  );
  for (const m of ACTIONS.matchAll(/redirect\(`\/verify\/([^`]*)`\)/g)) {
    assert.equal(m[1], "${sessionId}", `verify redirect carries extra: ${m[1]}`);
  }
});

test("the verify page no longer reads searchParams", () => {
  const page = readFileSync(
    new URL("../apps/ownership-planner/app/verify/[sessionId]/page.tsx", import.meta.url),
    "utf8"
  );
  assert.ok(!page.includes("searchParams"), "the page still reads the query string");
  assert.ok(page.includes("VERIFY_FLASH_COOKIE"), "the page does not read the flash cookie");
});

// ─── Ported back from the directly-deployed v4 and v12 (2026-09-27) ──────────
//
// Both functions were deployed straight through the Management API as
// comment-stripped condensations of this repo's logic. Diffing them against the
// repo turned up two things the deployed code had and the repo did not, so the
// "all" workflow run would have quietly reverted them. Ported, with the cases
// that would have caught each.

test("the endpoint skips $-prefixed keys too, not just the console", () => {
  // Defence in depth. The console filters to known rating inputs before posting,
  // so this should never fire -- but refusing a whole save over React's own
  // hidden $ACTION_ID field is bad enough to be worth blocking on both sides.
  const verify = readFileSync(
    new URL("../supabase/functions/fni-session-verify/index.ts", import.meta.url),
    "utf8"
  );
  const save = between(verify, "async function save(", "// ── discard:");
  assert.match(
    save,
    /if \(rawKey\.startsWith\("\$"\)\) continue;/,
    "save() must skip framework-internal fields rather than reject them"
  );
  // Skipped, not rejected: it is not a field anybody asked to edit.
  const skipAt = save.indexOf('rawKey.startsWith("$")');
  const rejectAt = save.indexOf("rejected.push(rawKey)");
  assert.ok(skipAt > 0 && rejectAt > skipAt, "the skip must come before the reject");
});

test("overriding the term actually moves the term", () => {
  // The rate builder resolves through finance-basis.ts, which prefers
  // finance_term_total over finance_term and apr over interest_rate. An override
  // list that named only the old columns was silently shadowed: a caller asking
  // for 48 months still got whatever finance_term_total held.
  const rate = readFileSync(
    new URL("../supabase/functions/fni-rate-vehicle/index.ts", import.meta.url),
    "utf8"
  );
  const list = between(rate, "const allowedOverrides = [", "];");
  for (const key of [
    "finance_term_total",
    "interest_rate",
    "finance_term",
    "apr",
    "amount_financed",
    "finance_type",
  ]) {
    assert.match(list, new RegExp(`"${key}"`), `${key} must be overridable`);
  }
});

test("every finance column the resolver reads is overridable", () => {
  // Derived from FinanceSource rather than listed again here, so adding a column
  // to the resolver fails this test until the override list catches up.
  const basis = readFileSync(
    new URL("../supabase/functions/_shared/finance-basis.ts", import.meta.url),
    "utf8"
  );
  const iface = between(basis, "export interface FinanceSource {", "}");
  const columns = [...iface.matchAll(/^\s*([a-z_]+)\??:/gm)].map((m) => m[1]);
  assert.ok(columns.length >= 8, `parsed too few columns: ${columns.join(", ")}`);

  const rate = readFileSync(
    new URL("../supabase/functions/fni-rate-vehicle/index.ts", import.meta.url),
    "utf8"
  );
  const list = between(rate, "const allowedOverrides = [", "];");
  const notOverridable = columns.filter((c) => !list.includes(`"${c}"`));
  assert.deepEqual(
    notOverridable,
    // lienholder_name is deliberately not overridable: it is the CRM's record of
    // who is financing the deal, and finance_type is the field that decides how a
    // deal rates.
    ["lienholder_name"],
    `finance columns the resolver reads but nothing can override: ${notOverridable.join(", ")}`
  );
});
