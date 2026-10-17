// A planning session keeps only the CRM fields the menu uses.
//
// A real deal (14957) showed fni.sessions.raw_snapshot holding the whole Zoho
// record: Social Security numbers, dates of birth, driver's license numbers and
// scans, credit scores. The snapshot is now built from an allow list, and these
// tests hold it there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MENU_CRM_FIELDS, menuSnapshot } from "../supabase/functions/_shared/crm-snapshot.ts";
import { mapSession } from "../supabase/functions/_shared/session-map.ts";
import { crmRatingFields } from "../supabase/functions/_shared/crm-fields.ts";
import { buildVerification, ratingInputs } from "../supabase/functions/_shared/verification.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** Fields that must never reach a session, with values easy to search for. */
const SENSITIVE = {
  Buyer_SSN: "123-45-6789",
  Co_Buyer_SSN: "987-65-4321",
  Buyer_DOB: "1971-04-12",
  Co_Buyer_DOB: "1974-11-30",
  Buyer_DL_Number: "WV-D1234567",
  Co_Buyer_DL_Number: "WV-D7654321",
  Buyer_DL_Upload: [{ File_Name__s: "buyer-license-scan.jpg", File_Id__s: "dl-file-111" }],
  Co_Buyer_DL_Upload: [{ File_Name__s: "cobuyer-license-scan.jpg", File_Id__s: "dl-file-222" }],
  Buyer_Credit_Score: 742,
  Co_Buyer_Credit_Score: 688,
  // Not in the brief's list, but on the real record too. The allow list keeps
  // them out without anybody naming them.
  Buyer_Credit_App: "credit-app-333",
  Buyer_Employer: "Acme Coal Company",
  Proof_of_Income: [{ File_Name__s: "paystub.pdf", File_Id__s: "income-444" }],
  // A field the CRM might grow next year. Excluded because nobody allowed it.
  Buyer_Passport_Number: "P99887766",
};

/** A DocuRide record with what the menu reads, plus everything it must not keep. */
const record = {
  id: "5566778899",
  Name: "14957",
  Store_Location: "Parkersburg",
  Sold_1_Stock_Number: "30111",
  Sold_1_VIN: "3JBUKAJ44TK002241",
  Sold_1_Year: "2026",
  Sold_1_Make: "Can-Am",
  Sold_1_Model: "Defender XT HD7",
  Sold_1_Condition: "New",
  Sold_1_Body_Type: "SxS",
  Sold_1_Meter: "1",
  Sold_1_Vehicle_DSP: "16,899.00",
  Sold_1_Down_Payment: "1,500.00",
  DC_Sold_1_Balance_Due: "19,764.64",
  TILA_APR: "8.99",
  TILA_Pmt1_Count: "60",
  TILA_Pmt1_Amount: "402.11",
  TILA_Amount_Financed: "19,764.64",
  Interest_Rate: "8.99",
  Term_Months: "60",
  Lienholder_Name: "Test Finance Co",
  Lienholder_City_State_ZIP: "Charleston, WV 25301",
  Sale_Date: "2026-10-16",
  Buyer_First_Name: "Pat",
  Buyer_Last_Name: "Example",
  Buyer_City: "Parkersburg",
  Buyer_State: "WV",
  Buyer_ZIP: "26101",
  ...SENSITIVE,
};

/** Every key and every scalar value anywhere inside a value. */
function everything(value, out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const v of value) everything(v, out);
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      everything(v, out);
    }
  } else {
    out.push(String(value));
  }
  return out;
}

/** The searchable strings a sensitive field would leave behind. */
function traces() {
  const found = [];
  for (const [k, v] of Object.entries(SENSITIVE)) {
    found.push(k);
    for (const s of everything(v)) if (!s.endsWith("__s")) found.push(s);
  }
  return found;
}

function assertClean(label, value) {
  const text = JSON.stringify(value);
  for (const t of traces()) {
    assert.ok(!text.includes(t), `${label} contains "${t}"`);
  }
}

test("a session made from a record with SSN, birth date, license and credit score holds none of them", () => {
  const session = mapSession(record, "store-1", "tenant-1", null, null, "Jim Stout");

  assertClean("the session row", session);
  assertClean("raw_snapshot", session.raw_snapshot);

  // The snapshot is still useful: it carries what the menu reads.
  assert.equal(session.raw_snapshot.Name, "14957");
  assert.equal(session.raw_snapshot.TILA_Amount_Financed, "19,764.64");
  assert.equal(session.raw_snapshot.Term_Months, "60");
  // And the columns came out as before.
  assert.equal(session.deal_number, "14957");
  assert.equal(session.sale_price, 16899);
  assert.equal(session.buyer_first_name, "Pat");
  assert.equal(session.finance_type, "Loan");
});

test("a refresh from the CRM writes none of them", () => {
  assertClean("the refresh patch", crmRatingFields(record));
});

test("the verification sheet and what is saved when verified hold none of them", () => {
  const session = mapSession(record, "store-1", "tenant-1", null, null, "Jim Stout");
  const sheet = buildVerification(session, ["vin", "year", "make", "model", "price"]);
  assertClean("the verification sheet", sheet);
  assertClean("the rating inputs", ratingInputs(sheet));
});

test("the snapshot keeps only allowed fields, whatever the record carries", () => {
  const snap = menuSnapshot({ ...record, Some_New_Field: "anything" });
  for (const key of Object.keys(snap)) {
    assert.ok(MENU_CRM_FIELDS.includes(key), `${key} is not on the allow list`);
  }
  assert.ok(!("Some_New_Field" in snap), "a field nobody allowed must be left out");
  // A field the record does not have is left out, not stored as undefined.
  assert.ok(!("Co_Buyer_Email" in snap));
});

test("the allow list names no sensitive kind of field", () => {
  const sensitive = /ssn|social|dob|birth|_dl_|licen[cs]e|credit|score|income|employ|salary|passport|upload|attach|bank|routing/i;
  for (const key of MENU_CRM_FIELDS) {
    assert.doesNotMatch(key, sensitive, `${key} looks sensitive and must not be kept`);
  }
  assert.equal(new Set(MENU_CRM_FIELDS).size, MENU_CRM_FIELDS.length, "the allow list has a repeat");
});

test("the snapshot keeps no contact fields: the session's columns hold them", () => {
  const contact = /^(Co_)?Buyer_|^Email$|^Lienholder_(?!Name$)/;
  for (const key of MENU_CRM_FIELDS) {
    assert.doesNotMatch(key, contact, `${key} is a contact field and must not be kept`);
  }

  const session = mapSession(
    { ...record, Buyer_Street_Address: "12 Elm St", Buyer_Phone: "304-555-0100", Email: "pat@example.com",
      Co_Buyer_First_Name: "Sam", Lienholder_Street: "1 Bank Plaza", Lienholder_Phone: "304-555-0199" },
    "store-1", "tenant-1", null, null, "Jim Stout"
  );
  for (const v of ["Pat", "Example", "12 Elm St", "304-555-0100", "pat@example.com", "Sam", "1 Bank Plaza", "304-555-0199"]) {
    assert.ok(!JSON.stringify(session.raw_snapshot).includes(v), `raw_snapshot holds "${v}"`);
  }
  // Still on the session, in its columns, for the contract.
  assert.equal(session.buyer_address, "12 Elm St");
  assert.equal(session.buyer_email, "pat@example.com");
  assert.equal(session.cobuyer_first_name, "Sam");
  assert.equal(session.lienholder_phone, "304-555-0199");
  // The lender's name is kept: a company, and what makes the deal a loan.
  assert.equal(session.raw_snapshot.Lienholder_Name, "Test Finance Co");
});

test("every non-contact field the mappings read is on the allow list", () => {
  const contact = /^(Co_)?Buyer_|^Email$|^Lienholder_(?!Name$)/;
  for (const file of ["../supabase/functions/_shared/session-map.ts", "../supabase/functions/_shared/crm-fields.ts"]) {
    for (const [, field] of src(file).matchAll(/record\.([A-Za-z0-9_]+)/g)) {
      if (contact.test(field)) continue;
      assert.ok(MENU_CRM_FIELDS.includes(field), `${file} reads ${field}, which the snapshot does not keep`);
    }
  }
});

test("every field fni-session-get recovers from the snapshot is on the allow list", () => {
  const get = src("../supabase/functions/fni-session-get/index.ts");
  const fields = [...get.matchAll(/snap\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(fields.length >= 5, "derivePaymentBasis no longer reads the snapshot the way this test expects");
  for (const field of fields) {
    assert.ok(MENU_CRM_FIELDS.includes(field), `fni-session-get reads ${field} from the snapshot`);
  }
});

test("nothing writes the whole CRM record to a session", () => {
  const start = src("../supabase/functions/fni-session-start/index.ts");
  const map = src("../supabase/functions/_shared/session-map.ts");
  assert.match(map, /raw_snapshot: menuSnapshot\(record\),/);
  assert.doesNotMatch(map + start, /raw_snapshot:\s*record\b/);
  // The only writer of raw_snapshot is mapSession.
  assert.doesNotMatch(start, /raw_snapshot\s*:/);
  for (const fn of ["fni-session-verify", "fni-session-get", "fni-rate-vehicle", "fni-session-save"]) {
    assert.doesNotMatch(
      src(`../supabase/functions/${fn}/index.ts`),
      /raw_snapshot\s*:/,
      `${fn} must not write raw_snapshot`
    );
  }
});
