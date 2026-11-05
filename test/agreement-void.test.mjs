// The contract record (fni.agreements) is Voided once every product under it
// is (5 Nov 2026). 15029 and 13759 went on saying Finalized with every
// product voided. Mock rows only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allProductsVoided, voidAgreementIfAllVoided } from "../supabase/functions/_shared/agreement-void.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

/** A fake client: agreement_products to read, agreements updates recorded. */
function fake(products, { failRead = false } = {}) {
  const updates = [];
  const supabase = {
    schema: () => ({
      from: (table) => ({
        select: () => ({ eq: async () => (failRead ? { data: null, error: { message: "down" } } : { data: products, error: null }) }),
        update: (patch) => ({ eq: (_c, id) => ({ neq: async (col, val) => { updates.push({ table, patch, id, unless: [col, val] }); return { error: null }; } }) }),
      }),
    }),
  };
  return { supabase, updates };
}

test("only when every product is voided, and there is at least one", () => {
  assert.equal(allProductsVoided([{ status: "Voided" }, { status: "Voided" }]), true);
  assert.equal(allProductsVoided([{ status: "Voided" }, { status: "Live" }]), false);
  assert.equal(allProductsVoided([{ status: "Voided" }, { status: "Submit Status Unknown" }]), false);
  assert.equal(allProductsVoided([]), false);
});

test("the last void sets the record Voided; one still live leaves it alone", async () => {
  const last = fake([{ status: "Voided" }, { status: "Voided" }]);
  assert.equal(await voidAgreementIfAllVoided(last.supabase, "agreement-1"), true);
  assert.deepEqual(last.updates, [{ table: "agreements", patch: { status: "Voided" }, id: "agreement-1", unless: ["status", "Voided"] }]);

  const notYet = fake([{ status: "Voided" }, { status: "Live" }]);
  assert.equal(await voidAgreementIfAllVoided(notYet.supabase, "agreement-2"), false);
  assert.deepEqual(notYet.updates, []);
});

test("a problem is logged and never fails the void", async () => {
  const down = fake([], { failRead: true });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await voidAgreementIfAllVoided(down.supabase, "agreement-3"), false);
  } finally {
    console.error = original;
  }
  assert.equal(await voidAgreementIfAllVoided(fake([]).supabase, null), false);
});

test("both voids call it, after the product is voided; nothing else changes the record", () => {
  const v = read("supabase/functions/fni-contract-void/index.ts");
  assert.ok(v.indexOf("await voidAgreementIfAllVoided(supabase, row.agreement_id);") > v.indexOf('status: "Voided",\n        voided_at'));
  const o = read("supabase/functions/fni-oem-contracts/index.ts");
  assert.ok(o.indexOf("await voidAgreementIfAllVoided(supabase, await agreementId(supabase, sessionId, false));") > o.indexOf('.update({ status: "Voided"'));
  // A later submit upserts the same record back to Draft, as before.
  assert.match(read("supabase/functions/fni-contract-submit/index.ts"), /status: "Draft",[\s\S]*?\{ onConflict: "session_id" \}/);
});
