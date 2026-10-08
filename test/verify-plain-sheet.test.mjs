// The Verify sheet looks plain when everything is fine, and only draws
// attention where the presenter has something to do.
//
// Where a value came from is not printed on any row. It is still in the sheet
// data and the verification snapshot, and in the row's tooltip. Display only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const page = src("../apps/ownership-planner/app/verify/[sessionId]/page.tsx");
const css = src("../apps/ownership-planner/app/globals.css");

const fieldFn = page.slice(
  page.indexOf("function Field("),
  page.indexOf("export default async function VerifyPage(")
);

test("no row prints its source", () => {
  // The only chip a row can render is Missing.
  // An optional field (the maximum amount financed) is never marked Missing.
  assert.match(page, /function MissingMarker\(\{ field \}: \{ field: VerifyField \}\) \{\s*return field\.source === "Missing" && !OPTIONAL_FIELDS\.has\(field\.key\)\s*\? <span className="tag tag--expired">Missing<\/span>\s*: null;\s*\}/);
  assert.match(fieldFn, /<MissingMarker field=\{field\} \/>/);
  assert.doesNotMatch(page, /<Source |function Source\(/);
  // And no row prints its source as text either.
  assert.doesNotMatch(fieldFn, />\s*\{field\.source\}\s*</);
  assert.doesNotMatch(page, /Values come from the CRM unless marked/);
});

test("the Was line is gone from the row and lives in the tooltip", () => {
  assert.doesNotMatch(fieldFn, /className="vfield-was"/);
  assert.match(fieldFn, /const wasLine = edited\s*\?\s*`Was \$\{field\.original \?\? "not set"\} \(\$\{field\.original_source\}\), changed by `/);
  assert.match(fieldFn, /const tip = \[field\.label, origin, field\.note, help, wasLine, wasDetail\]/);
  assert.match(fieldFn, /className=\{`vfield \$\{state\}`\} title=\{tip\}/);
});

test("the tooltip still says where the value came from", () => {
  assert.match(fieldFn, /field\.source === "CRM" \? \(field\.note \? null : "From the CRM deal\."\)/);
  assert.match(fieldFn, /: `Source: \$\{field\.source\}\.`;/);
});

test("the source column is gone and rows keep two columns", () => {
  assert.match(css, /grid-template-columns: minmax\(8rem, 13rem\) minmax\(0, 1fr\);\n/);
  assert.match(css, /grid-template-columns: minmax\(6\.5rem, 42%\) minmax\(0, 1fr\);\n/);
  assert.doesNotMatch(css, /5\.5rem;|2\.7rem;/);
  // The Missing marker sits under the label rather than in a column of its own.
  assert.match(css, /\.vfield > \.tag \{ grid-column: 1; grid-row: 2; justify-self: start; \}/);
  assert.doesNotMatch(css, /tag--none|vsheet-legend|\.vfield-was|is-edited|is-differs/);
});

test("Missing keeps its treatment", () => {
  assert.match(fieldFn, /: field\.missing \? "is-missing"/);
  assert.match(css, /\.vfield\.is-missing \{ border-left-color: var\(--copper\); background: var\(--copper-wash\); \}/);
  assert.match(css, /\.console--verify \.vgroup \.vfield\.is-missing \{ background: var\(--copper-wash\); border-left: 2px solid var\(--copper\);/);
});

test("a value changed away from the CRM gets only a copper edge on its box", () => {
  // Not for a value typed into an empty field, or one the CRM does not carry.
  assert.match(fieldFn, /const changedFromCrm =\s*field\.differs_from_crm && field\.original !== null && field\.original_source !== "Missing";/);
  assert.match(fieldFn, /: changedFromCrm \? "is-changed"/);
  assert.match(css, /\.vfield\.is-changed \.vfield-control > input,\n\.vfield\.is-changed \.vfield-control > select \{ border-left: 3px solid var\(--copper\); \}/);
  // differs_from_crm is already false for a field the CRM does not carry.
  const verification = src("../supabase/functions/_shared/verification.ts");
  assert.match(verification, /differs_from_crm:\s*edit !== undefined && in_crm && !invalid/);
});

test("invalid edits keep their error treatment", () => {
  assert.match(fieldFn, /field\.invalid \? "is-invalid"/);
  assert.match(fieldFn, /aria-invalid=\{field\.invalid \? true : undefined\}/);
  assert.match(css, /\.vfield\.is-invalid \{ border-left-color: var\(--copper-ink\); background: var\(--copper-wash\); \}/);
  assert.match(css, /\.vfield\.is-invalid input \{ border-color: var\(--copper-ink\); \}/);
});

test("the CRM warning panel and the decode line are unchanged", () => {
  assert.match(page, /<div className="vgate-warn" role="alert">\s*<p className="vgate-warn-say">\{sheet\.crm_warning\}<\/p>/);
  assert.match(page, /The automatic VIN decode did not answer\. Press Decode the VIN to try again\./);
});
