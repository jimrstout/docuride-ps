// Multi-provider Part 6: admin sections.
//
// Providers, Menus and Price sheets in the admin area. The store account check
// is back in the database before any screen edits store accounts; a sheet goes
// straight from the browser to the bucket; nothing deletes; refusals are
// sentences.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  conditionsLine,
  listOf,
  parseProvider,
  parseSlot,
  parseStoreIds,
  parseTemplate,
} from "../supabase/functions/_shared/menu-admin.ts";
import { parseUpload } from "../supabase/functions/_shared/price-sheet-admin.ts";
import { ADMIN_SECTIONS } from "../apps/ownership-planner/lib/admin-sections.ts";
import { fitsLine, termLine, rateMoney } from "../apps/ownership-planner/lib/price-sheets.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333333";

test("the store account check is restored, provider-aware, and checks existing rows first", () => {
  const sql = src("../supabase/migrations/0026_store_account_provider_check.sql");
  assert.doesNotMatch(sql, /\bdrop\b/i);
  assert.match(sql, /if p_kind = 'Connected' then/);
  assert.match(sql, /needs a login and a Dealer ID/);
  assert.match(sql, /if login_for is distinct from p_adapter then/);
  assert.match(sql, /has no API, so its store account takes no login/);
  assert.match(sql, /would fail the provider check\. Fix them first\./);
  assert.match(sql, /before insert or update on fni\.store_provider_accounts/);
  // The open item from Part 1 is closed in the design doc.
  assert.match(src("../docs/multi-provider.md"), /restored in Part 6 by migration 0026/);
});

test("providers: a name is required; makes are a list; a new one is a Price Sheet provider", () => {
  assert.deepEqual(parseProvider({ name: "", makes: "" }).errors, ["Give the provider a name."]);
  const ok = parseProvider({ name: " Yamaha ", makes: "Yamaha, Yamaha WaveRunner, Yamaha", active: "on" });
  assert.deepEqual(ok.fields, { name: "Yamaha", makes: ["Yamaha", "Yamaha WaveRunner"], active: true, notes: null, document_prefix: null });
  const handler = src("../supabase/functions/fni-admin-settings/providers.ts");
  assert.match(handler, /kind: "Price Sheet",\s*adapter: null,\s*contract_method: "Recorded by Staff",/);
  assert.match(handler, /store accounts carry a login and a Dealer ID, so they are set up by DocuRide staff/);
  assert.deepEqual(parseStoreIds([S1, "nope"], [S1]).errors, ["One of those stores does not exist."]);
});

test("menus: conditions are checked and read back in plain English", () => {
  const t = parseTemplate(
    { name: "New Can-Am", makes: "Can-Am", conditions: ["New"], deal_types: ["Loan"], vehicle_types: ["utv"], store_ids: [S1], priority: "5", active: "on" },
    [S1, S2]
  );
  assert.deepEqual(t.fields, {
    name: "New Can-Am", description: null, store_ids: [S1], deal_types: ["Loan"], vehicle_types: ["UTV"],
    conditions: ["New"], makes: ["Can-Am"], priority: 5, active: true,
  });
  assert.equal(conditionsLine(t.fields, () => "Parkersburg"), "New, Can-Am, UTV, Loan deals, at Parkersburg");
  assert.equal(conditionsLine({ store_ids: [], deal_types: [], vehicle_types: [], conditions: [], makes: [] }, () => ""), "Every deal");
  assert.deepEqual(parseTemplate({ name: "", conditions: ["Old"], priority: "x" }, []).errors, [
    "Give the menu a name, such as \"New Can-Am\".",
    "New or Used must be New, Used, or both.",
    "Priority is a whole number from 0 to 1,000.",
  ]);
});

test("slots: products from the catalog, in order; Best Match or Side by Side", () => {
  const s = parseSlot({ title: "Mechanical Protection", mode: "Best Match", category: "Mechanical Protection", product_ids: [P1] }, [P1]);
  assert.deepEqual(s.fields, { title: "Mechanical Protection", category: "Mechanical Protection", mode: "Best Match", product_ids: [P1] });
  assert.deepEqual(parseSlot({ title: "X", mode: "Whatever", product_ids: ["nope"] }, [P1]).errors, [
    "Show must be Best Match or Side by Side.",
    "One of those products is not in the catalog.",
  ]);
  assert.deepEqual(listOf("a, b,,a "), ["a", "b"]);
  // The slot form orders products by the number typed beside each.
  const actions = src("../apps/ownership-planner/app/console-actions.ts");
  assert.match(actions, /\.sort\(\(a, b\) => a\.n - b\.n \|\| a\.i - b\.i\)/);
});

test("the admin menu lists the new sections, each page checks the operator first", () => {
  assert.deepEqual(ADMIN_SECTIONS.map((s) => s.href), [
    "/admin/sessions", "/admin/pricing", "/admin/providers", "/admin/menus", "/admin/price-sheets", "/admin/wording", "/admin/stores",
  ]);
  for (const page of [
    "../apps/ownership-planner/app/admin/providers/page.tsx",
    "../apps/ownership-planner/app/admin/menus/page.tsx",
    "../apps/ownership-planner/app/admin/price-sheets/page.tsx",
    "../apps/ownership-planner/app/admin/price-sheets/[sheetId]/page.tsx",
  ]) {
    const body = src(page);
    assert.match(body, /const operator = await currentOperator\(\);\s*if \(!operator\) return null;/, page);
    assert.doesNotMatch(body, /"use client"/, page);
    assert.doesNotMatch(body, /—/, page);
  }
});

test("a sheet goes from the browser straight to the bucket, never through the server", () => {
  const upload = src("../apps/ownership-planner/components/admin/SheetUpload.tsx");
  assert.match(upload, /^"use client";/);
  assert.match(upload, /await priceSheetUploadUrl\(provider, file\.name\)/);
  assert.match(upload, /fetch\(started\.signed_url, \{ method: "PUT", body/);
  // The server action that records it takes a path, not the file.
  const actions = src("../apps/ownership-planner/app/console-actions.ts");
  assert.match(actions, /file_path: field\(fd, "file_path"\),/);
  assert.doesNotMatch(actions, /file_base64/);
  // A reported path must be this provider's.
  const bad = parseUpload({ provider_id: S1, name: "BRP", effective_from: "2026-01-01", file_name: "a.pdf", file_path: `${S2}/${S1}/a.pdf`, uploaded_by: "Jim" });
  assert.deepEqual(bad.errors, ["The uploaded file could not be found."]);
  const ok = parseUpload({ provider_id: S1, name: "BRP", effective_from: "2026-01-01", file_name: "a.pdf", file_path: `${S1}/${S2}/a.pdf`, uploaded_by: "Jim" });
  assert.equal(ok.fields.file_path, `${S1}/${S2}/a.pdf`);
  assert.equal(ok.fields.bytes, null);
});

test("every write names the operator, and nothing deletes", () => {
  const actions = src("../apps/ownership-planner/app/console-actions.ts");
  const part6 = actions.slice(actions.indexOf("// ── Providers, Menus and Price sheets"));
  assert.match(part6, /const operator = await currentOperator\(\);\s*if \(!operator\) redirect\(back\);/);
  assert.match(part6, /result = await write\(operator\.email\);/);
  for (const f of [
    "../supabase/functions/fni-admin-settings/providers.ts",
    "../supabase/functions/fni-admin-settings/templates.ts",
  ]) {
    assert.doesNotMatch(src(f), /\.delete\(/, f);
  }
});

test("a rate reads in plain English on the review page", () => {
  const r = {
    makes: ["Can-Am"], model_contains: [], vehicle_types: ["UTV"], conditions: ["New"],
    year_min: 2024, year_max: null, max_age_years: null, max_odometer: 1000,
    engine_cc_min: null, engine_cc_max: 1000, max_months_in_service: null,
    term_months: 36, term_miles: null,
  };
  assert.equal(fitsLine(r), "Can-Am, UTV, New, 2024 and newer, 1,000 or fewer on the odometer, up to 1000 cc");
  assert.equal(termLine(r), "36 months");
  assert.equal(rateMoney("410.00"), "$410.00");
  assert.equal(rateMoney(null), "Not stated");
});
