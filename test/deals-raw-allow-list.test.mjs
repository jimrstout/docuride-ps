// public.deals.raw keeps only an allow list of CRM fields.
//
// raw used to be the whole Zoho record minus ten named fields, which left
// employer, proof of income and the credit application in all 296 deals, where
// anyone who can sign in could read them. It is now built from RAW_FIELDS, and
// these tests hold it there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapDeal, RAW_FIELDS } from "../supabase/functions/_shared/dealmap.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** Fields that must never reach a deal row, with values easy to search for. */
const SENSITIVE = {
  Buyer_SSN: "123-45-6789",
  Co_Buyer_SSN: "987-65-4321",
  Buyer_DOB: "1971-04-12",
  Co_Buyer_DOB: "1974-11-30",
  Buyer_DL_Number: "WV-D1234567",
  Co_Buyer_DL_Number: "WV-D7654321",
  Buyer_DL_Upload: [{ File_Name__s: "buyer-license-scan.jpg", File_Id__s: "dl-file-111" }],
  Buyer_Credit_Score: 742,
  Co_Buyer_Credit_Score: 688,
  Buyer_Employer: "Acme Coal Company",
  Co_Buyer_Employer: "Ohio Valley Hospital",
  Proof_of_Income: [{ File_Name__s: "paystub.pdf", File_Id__s: "income-444" }],
  Buyer_Credit_App: { id: "credit-app-333", name: "CA-0001 Pat Example" },
  Co_Buyer_Credit_App: { id: "credit-app-334", name: "CA-0002 Sam Example" },
  // A field the CRM might grow next year. Left out because nobody allowed it.
  Buyer_Passport_Number: "P99887766",
};

const record = {
  id: "5566778899",
  Modified_Time: "2026-10-17T09:30:00-04:00",
  Name: "14957",
  Store_Location: "Parkersburg",
  Deal_Status: "Sold",
  Sale_Date: "2026-10-16",
  Buyer_Display_Name: "Pat Example",
  Buyer_Last_Name: "Example",
  Sold_1_VIN: "3JBUKAJ44TK002241",
  Sold_1_Vehicle_DSP: "16,899.00",
  TILA_Amount_Financed: "19,764.64",
  Dealership_Name: "All Seasons Powersports",
  Trade_1_Year: "2019",
  ...SENSITIVE,
};

/** Every scalar value inside a value. */
function values(value, out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) for (const v of value) values(v, out);
  else if (typeof value === "object") for (const v of Object.values(value)) values(v, out);
  else out.push(String(value));
  return out;
}

/** What a sensitive field would leave behind: its name and its values. */
function traces(fields) {
  return [...Object.keys(fields), ...values(fields)];
}

test("a record with SSN, birth date, license, credit score, employer, income and credit application produces a raw with none of them", () => {
  const row = mapDeal(record, "tenant-1");
  const raw = JSON.stringify(row.raw);
  for (const t of traces(SENSITIVE)) assert.ok(!raw.includes(t), `raw contains "${t}"`);
  // And nowhere else in the row either.
  const whole = JSON.stringify(row);
  for (const t of traces(SENSITIVE)) assert.ok(!whole.includes(t), `the deal row contains "${t}"`);
});

test("raw keeps exactly the allowed fields", () => {
  const row = mapDeal({ ...record, Some_New_Field: "anything" }, "tenant-1");
  assert.deepEqual(row.raw, { id: "5566778899", Modified_Time: "2026-10-17T09:30:00-04:00" });
  for (const key of Object.keys(row.raw)) assert.ok(RAW_FIELDS.includes(key));
});

test("the promoted columns and the money groups are unchanged", () => {
  const row = mapDeal(record, "tenant-1");
  assert.equal(row.zoho_id, "5566778899");
  assert.equal(row.deal_number, "14957");
  assert.equal(row.buyer_display_name, "Pat Example");
  assert.equal(row.vin, "3JBUKAJ44TK002241");
  assert.equal(row.financials.Vehicle_DSP, "16,899.00");
  assert.equal(row.tila.Amount_Financed, "19,764.64");
  assert.equal(row.dealership.Name, "All Seasons Powersports");
  assert.deepEqual(row.trades, [{ slot: 1, Year: "2019" }]);
});

test("the allow list names no sensitive kind of field", () => {
  const sensitive = /ssn|social|dob|birth|_dl_|licen[cs]e|credit|score|income|employ|salary|passport|upload|attach|bank|routing|buyer|email|phone|address/i;
  for (const key of RAW_FIELDS) assert.doesNotMatch(key, sensitive, key);
});

test("the mapping keeps no list of fields to drop", () => {
  const map = src("../supabase/functions/_shared/dealmap.ts");
  assert.doesNotMatch(map, /REDACTED_FIELDS|function redact\(/);
  assert.match(map, /raw: rawFields\(record\),/);
});

test("the deals page neither fetches nor shows raw", () => {
  const page = src("../deals.html");
  assert.doesNotMatch(page, /"raw"/);
  assert.doesNotMatch(page, /raw JSON/);
  assert.doesNotMatch(page, /\.select\("\*"\)/);
  assert.match(page, /\.select\(DETAIL_COLS\)/);
  assert.match(page, /const JSONB_COLS = \["dealership","tila","financials","trades"\];/);
});

test("the migration trims existing rows to the same allow list", () => {
  const sql = src("../supabase/migrations/0022_deals_raw_allow_list.sql");
  const keys = [...sql.matchAll(/e\.key in \(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(keys.length, 1);
  assert.deepEqual(keys[0].split(",").map((k) => k.trim().replace(/'/g, "")), [...RAW_FIELDS]);
  // The trim must not restamp every deal as changed today.
  assert.match(sql, /disable trigger deals_touch;[\s\S]*update public\.deals[\s\S]*enable trigger deals_touch;/);
  assert.doesNotMatch(sql, /\bdrop\b/i);
});
