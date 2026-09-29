// Verify, Financial section: Lender moves here, the agreed down payment is
// shown from the CRM, and the finance company's maximum amount financed is
// typed here, with a warning when the deal is already over it.
//
// None of the three is a TecAssured rating input. The maximum is the one that
// is edited, so the tests below pin that saving it can never reset a
// verification or mark rates out of date.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildVerification,
  changedInputs,
  editableKeys,
  overCapWarning,
  ratingInputs,
} from "../supabase/functions/_shared/verification.ts";
import { crmRatingFields } from "../supabase/functions/_shared/crm-fields.ts";
import { capChange, MAX_AMOUNT_FINANCED } from "../supabase/functions/fni-session-verify/save-edits.ts";
import { ratingInputsFrom } from "../apps/ownership-planner/lib/verify-fields.ts";

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

const UTV = [
  "vin", "fuel.type", "year", "make", "model", "new.used", "engine.ccs",
  "finance.type", "finance.amount", "finance.apr", "finance.term", "odometer",
  "price", "sale.date", "inservice.date", "Warranty", "postal.code",
];

/** Deal 13759, financed through Roadrunner, $1,000 down. */
const financed = (over = {}) => ({
  deal_number: "13759", stock_number: "29001", finance_type: "Loan",
  sale_date: "2026-09-20",
  vin: "3JBUKAJ44TK002241", unit_year: 2026, unit_make: "Can-Am",
  unit_model: "Defender", condition: "New", vehicle_type_code: "UTV",
  odometer: 5, in_service_date: "2026-09-20",
  sale_price: "24999", amount_financed: "27547.64", finance_term: 60, apr: null,
  interest_rate: 6.99, finance_term_total: 60, tila_amount_financed: null,
  lienholder_name: "Roadrunner Financial LLC.",
  agreed_down_payment: "1000", max_amount_financed: null,
  buyer_city: "Barboursville", buyer_state: "WV", buyer_zip: "25504",
  vehicle_properties: { "engine.ccs": "650", warranty: "6" },
  vin_decode: null,
  ...over,
});

const cash = (over = {}) =>
  financed({ finance_type: "Cash", lienholder_name: null, amount_financed: "0", ...over });

const byKey = (sheet) => Object.fromEntries(sheet.fields.map((f) => [f.key, f]));

// ── 1. Lender ─────────────────────────────────────────────────────────────

test("Lender is shown first in Financial, and nothing else about it changes", () => {
  const sheet = buildVerification(financed(), UTV);
  const money = sheet.fields.filter((f) => f.group === "Money");
  assert.equal(money[0].key, "lender");
  assert.ok(!sheet.fields.some((f) => f.group === "Deal" && f.key === "lender"));
  const lender = byKey(sheet).lender;
  assert.equal(lender.value, "Roadrunner Financial LLC.");
  assert.equal(lender.editable, false);
  assert.equal(lender.provider_property, null);
  // The Money group is headed Financial on the page.
  assert.match(src("../apps/ownership-planner/app/verify/[sessionId]/page.tsx"),
    /\{group === "Money" \? "Financial" : group\}/);
});

// ── 2. Agreed down payment ────────────────────────────────────────────────

test("the down payment maps from Sold_1_Down_Payment", () => {
  assert.equal(crmRatingFields({ Sold_1_Down_Payment: "1000" }).agreed_down_payment, 1000);
  assert.equal(crmRatingFields({ Sold_1_Down_Payment: "5,500.00" }).agreed_down_payment, 5500);
  assert.equal(crmRatingFields({ Sold_1_Down_Payment: null }).agreed_down_payment, null);
  // Not TILA_Down_Payment, which adds positive trade-in equity to it.
  assert.equal(
    crmRatingFields({ Sold_1_Down_Payment: "1500", TILA_Down_Payment: "13,000.00" }).agreed_down_payment,
    1500
  );
});

test("creation, reopen and Refresh all fill it through the shared mapping", () => {
  const start = src("../supabase/functions/fni-session-start/index.ts");
  const mapSession = start.slice(start.indexOf("function mapSession("), start.indexOf("function json("));
  assert.match(mapSession, /const crm = crmRatingFields\(record/);
  assert.match(mapSession, /agreed_down_payment: crm\.agreed_down_payment,/);

  // Reopen writes the whole shared patch.
  const reopen = start.slice(start.indexOf("async function reopen("), start.indexOf("async function ratingInputsChanged("));
  assert.match(reopen, /const patch = crmRatingFields\(record as unknown as Record<string, unknown>\);/);
  assert.match(reopen, /\.update\(patch\)/);

  // Refresh from CRM writes the same patch, and the sheet reads the column.
  const verify = src("../supabase/functions/fni-session-verify/index.ts");
  const refresh = verify.slice(verify.indexOf("async function refresh("), verify.indexOf("async function verify("));
  assert.match(refresh, /const patch = crmRatingFields\(record as unknown as Record<string, unknown>\);/);
  assert.match(refresh, /\.update\(patch\)/);
  assert.match(verify, /"agreed_down_payment", "max_amount_financed",/);
});

test("the down payment shows as read only currency, with its hover text", () => {
  const f = byKey(buildVerification(financed(), UTV)).agreed_down_payment;
  assert.equal(f.label, "Down payment");
  assert.equal(f.group, "Money");
  assert.equal(f.value, "$1,000.00");
  assert.equal(f.editable, false);
  assert.equal(f.required, false);
  assert.equal(f.note, "The down payment agreed on the deal, before any protection products.");
});

// ── 3. Maximum amount financed ────────────────────────────────────────────

test("the maximum is shown and editable on a financed deal, and hidden on cash", () => {
  const onLoan = byKey(buildVerification(financed(), UTV)).max_amount_financed;
  assert.equal(onLoan.label, "Maximum amount financed");
  assert.equal(onLoan.editable, true);
  assert.equal(onLoan.required, false);
  assert.equal(onLoan.missing, false, "blank is a fine answer");
  assert.ok(editableKeys(financed()).includes(MAX_AMOUNT_FINANCED));

  assert.equal(byKey(buildVerification(cash(), UTV)).max_amount_financed, undefined);
  assert.ok(!editableKeys(cash()).includes(MAX_AMOUNT_FINANCED));
  // A Loan with no lienholder attached is not treated as financed here.
  assert.equal(
    byKey(buildVerification(financed({ lienholder_name: null }), UTV)).max_amount_financed,
    undefined
  );
});

test("$27,000, 27000 and 27,000.00 are the same maximum", () => {
  const now = "2026-09-29T18:00:00.000Z";
  for (const typed of ["$27,000", "27000", "27,000.00", " 27000.00 "]) {
    const c = capChange(typed, null, "Jim", now);
    assert.equal(c.kind, "set", typed);
    assert.equal(c.column, "27000.00", typed);
  }
  // Already stored, in any of those forms: nothing changes.
  for (const typed of ["$27,000", "27000", "27,000.00"]) {
    assert.equal(capChange(typed, "27000", "Jim", now).kind, "unchanged", typed);
    assert.equal(capChange(typed, "27000.00", "Jim", now).kind, "unchanged", typed);
  }
});

test("the maximum saves with the name and time on it", () => {
  const c = capChange("$27,000", null, "Jim Stout", "2026-09-29T18:00:00.000Z");
  assert.deepEqual(c.edit, {
    value: "27000.00",
    original: null,
    original_source: "Missing",
    edited_by: "Jim Stout",
    edited_at: "2026-09-29T18:00:00.000Z",
  });
  const changed = capChange("26500", "27000", "Pat", "2026-09-29T19:00:00.000Z");
  assert.equal(changed.column, "26500.00");
  assert.equal(changed.edit.original, "$27,000.00");
  assert.equal(changed.edit.edited_by, "Pat");

  // Blank clears the column and the attribution.
  assert.deepEqual(capChange("", "27000", "Pat", "x"), { kind: "set", column: null, edit: null });
  assert.equal(capChange("", null, "Pat", "x").kind, "unchanged");
});

test("negatives and non-numbers are unreadable", () => {
  for (const junk of ["-5", "-$1,000", "abc", "12abc", "27,000 approx", "$"]) {
    assert.equal(capChange(junk, null, "Jim", "x").kind, "unreadable", junk);
  }
  const verify = src("../supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /if \(change\.kind === "unreadable"\) \{\s*unreadable\.push\(\{ key, label: labelFor\(key\), value \}\);/);
});

test("saving the maximum cannot touch verification or the rates", () => {
  // It is not a rating input, so the gate's comparison cannot see it change.
  const before = ratingInputs(buildVerification(financed(), UTV));
  const after = ratingInputs(buildVerification(financed({ max_amount_financed: "27000" }), UTV));
  assert.ok(!(MAX_AMOUNT_FINANCED in before));
  assert.ok(!("agreed_down_payment" in before) && !("lender" in before));
  assert.deepEqual(changedInputs(before, after), []);

  // And save() writes only staff_edits and the column: no verification state,
  // no snapshot, and no rated_offers.out_of_date.
  const verify = src("../supabase/functions/fni-session-verify/index.ts");
  const save = verify.slice(verify.indexOf("async function save("), verify.indexOf("async function discardEdits("));
  assert.doesNotMatch(save, /verification_state|verified_snapshot|out_of_date|rated_offers/);
  assert.match(save, /\.update\(\{ staff_edits: Object\.keys\(edits\)\.length > 0 \? edits : null, \.\.\.columns \}\)/);
  assert.match(save, /columns\.max_amount_financed = change\.column;/);
});

test("the form posts the maximum, and it is not in the rating input list", () => {
  assert.deepEqual(ratingInputsFrom([["max_amount_financed", "$27,000"]]), {
    max_amount_financed: "$27,000",
  });
  const fields = src("../apps/ownership-planner/lib/verify-fields.ts");
  assert.match(fields, /export const OTHER_VERIFY_INPUT_NAMES: readonly string\[\] = \["max_amount_financed"\];/);
});

// ── 4. Over the maximum ───────────────────────────────────────────────────

test("the warning appears only when a maximum is set and already exceeded", () => {
  // 27,547.64 financed against a 27,000 maximum: 547.64 over, to the penny.
  assert.equal(
    overCapWarning(financed({ max_amount_financed: "27000" })),
    "The amount financed is already $547.64 over the maximum from the finance " +
      "company, before any protection products."
  );
  assert.equal(overCapWarning(financed()), null, "no maximum set");
  assert.equal(overCapWarning(financed({ max_amount_financed: "30000" })), null, "under it");
  assert.equal(overCapWarning(financed({ max_amount_financed: "27547.64" })), null, "exactly at it");
  assert.equal(overCapWarning(cash({ max_amount_financed: "1" })), null, "cash deal");

  // On the sheet, and printed under Financial only. It does not block Confirm.
  const sheet = buildVerification(financed({ max_amount_financed: "27000" }), UTV);
  assert.match(sheet.over_cap_warning, /\$547\.64 over/);
  assert.equal(sheet.ready, true);
  const page = src("../apps/ownership-planner/app/verify/[sessionId]/page.tsx");
  assert.match(page, /\{group === "Money" && sheet\.over_cap_warning \? \(\s*<p className="vgroup-warn" role="status">\{sheet\.over_cap_warning\}<\/p>/);
});

test("an empty maximum is never marked Missing", () => {
  const page = src("../apps/ownership-planner/app/verify/[sessionId]/page.tsx");
  assert.match(page, /const OPTIONAL_FIELDS = new Set\(\["max_amount_financed"\]\);/);
});
