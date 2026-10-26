// A provider's document prefix starts the WorkDrive name of its documents.
// Riders Advantage is "TA"; the OEM providers start blank.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseProvider } from "../supabase/functions/_shared/menu-admin.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("a prefix is two to six letters or digits, stored in capitals; blank is allowed", () => {
  assert.equal(parseProvider({ name: "BRP", document_prefix: " brp " }).fields.document_prefix, "BRP");
  assert.equal(parseProvider({ name: "BRP", document_prefix: "" }).fields.document_prefix, null);
  assert.deepEqual(parseProvider({ name: "BRP", document_prefix: "B-1" }).errors, [
    "The document prefix is two to six letters or digits, such as TA.",
  ]);
});

test("migration 0028 is additive, unique per tenant, and gives Riders Advantage TA", () => {
  const sql = src("../supabase/migrations/0028_provider_document_prefix.sql");
  assert.doesNotMatch(sql, /\bdrop\b/i);
  assert.match(sql, /on fni\.providers \(tenant_id, document_prefix\)\s+where document_prefix is not null/);
  assert.match(sql, /set document_prefix = 'TA'\s+where adapter = 'TecAssured' and name = 'Riders Advantage'/);
  const handler = src("../supabase/functions/fni-admin-settings/providers.ts");
  assert.match(handler, /Another provider already uses the document prefix/);
  assert.match(src("../apps/ownership-planner/app/admin/providers/page.tsx"), /name="document_prefix"/);
});
