// Matching rated products to their copy, and telling the two failure modes
// apart.
//
// A product withheld because its copy is not written is a decision. A product
// that matched nothing in the catalog is a defect. Both used to end as the same
// silent absence from the customer's list, which is how a store stops offering
// GAP for a month with nobody noticing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCoverage,
  indexCatalog,
  joinFailureReport,
} from "../supabase/functions/_shared/planner-catalog.ts";
import { allTiers, normalizeOffer } from "../supabase/functions/_shared/planner-offers.ts";
import { readFileSync } from "node:fs";

/** The real quote, so the join is tested on the codes production will see. */
const QUOTE = JSON.parse(
  readFileSync(new URL("./fixtures/tecassured-rate-utv-3-306.json", import.meta.url), "utf8")
);

const STORE = "7428435c";

function row(code, opts = {}) {
  return {
    product_code: code,
    display_name: opts.display_name ?? code,
    store_id: opts.store_id ?? STORE,
    is_presentable: opts.is_presentable ?? true,
  };
}

/**
 * A catalog covering the real quote, with Platinum registered and its copy
 * unwritten. Real provider codes: "84_7", "16_3" and so on, which is the point.
 * The old version of this test used codes a person had invented on both sides
 * of the join, so it could not fail the way production would.
 */
const PLATINUM = "84_7";

const OFFERED = allTiers(normalizeOffer(QUOTE)).map((t) => ({
  product_code: t.product_code,
  product_name: t.product_name,
}));

const SEEDED = indexCatalog(
  OFFERED.map((p) =>
    row(p.product_code, {
      display_name: p.product_name,
      is_presentable: p.product_code !== PLATINUM,
    })
  )
);

/** Eleven products across five families. */
const OFFERED_COUNT = OFFERED.length;

test("the seeded offer matches every product it rates", () => {
  const c = classifyCoverage(OFFERED, SEEDED);
  assert.equal(c.offered, OFFERED_COUNT);
  assert.equal(c.matched, OFFERED_COUNT);
  assert.deepEqual(c.unmatched, [], "nothing should be unmatched against the seed");
});

test("a product whose copy is unwritten is withheld, and says so", () => {
  const c = classifyCoverage(OFFERED, SEEDED);
  assert.deepEqual(c.copy_pending, [
    {
      product_code: PLATINUM,
      display_name: "USED PLATINUM UTV (Side by Side) - RIDERS ADVANTAGE PPM",
    },
  ]);
});

// The assertion this whole change exists for.
test("an unrecognised product is not reported as a withheld one", () => {
  const withoutPlatinum = indexCatalog(
    [...SEEDED.values()].filter((r) => r.product_code !== PLATINUM)
  );
  const c = classifyCoverage(OFFERED, withoutPlatinum);

  // Platinum now has no row at all, so it is a join failure, not a decision.
  assert.deepEqual(c.unmatched, [
    {
      product_code: PLATINUM,
      product_name: "USED PLATINUM UTV (Side by Side) - RIDERS ADVANTAGE PPM",
    },
  ]);
  assert.deepEqual(c.copy_pending, []);

  // And the two classifications never overlap.
  const pending = new Set(c.copy_pending.map((p) => p.product_code));
  for (const u of c.unmatched) assert.equal(pending.has(u.product_code), false);
});

test("the same product reads differently depending on why it is absent", () => {
  const registered = classifyCoverage(OFFERED, SEEDED);
  const absent = classifyCoverage(
    OFFERED,
    indexCatalog([...SEEDED.values()].filter((r) => r.product_code !== PLATINUM))
  );

  // Identical customer-facing outcome -- PPM is not shown either way -- but the
  // two cases are no longer indistinguishable from the outside.
  assert.equal(registered.copy_pending.length, 1);
  assert.equal(registered.unmatched.length, 0);
  assert.equal(absent.copy_pending.length, 0);
  assert.equal(absent.unmatched.length, 1);
});

// The failure the audit expects on credential day: the join runs on
// productUnique, and the mock matches only because one person wrote both sides.
test("numeric provider codes fail loudly instead of emptying the page", () => {
  const numeric = OFFERED.map((p, i) => ({ ...p, product_code: String(90001 + i) }));
  const c = classifyCoverage(numeric, SEEDED);

  assert.equal(c.matched, 0);
  assert.equal(c.unmatched.length, OFFERED_COUNT);
  assert.equal(c.copy_pending.length, 0, "none of this is a copy decision");

  const report = joinFailureReport("sess-1", STORE, c, numeric.map((p) => p.product_code));
  const parsed = JSON.parse(report);
  assert.deepEqual(
    parsed.unmatched_codes,
    Array.from({ length: OFFERED_COUNT }, (_, i) => String(90001 + i))
  );
  assert.equal(parsed.session_id, "sess-1");
  assert.equal(parsed.store_id, STORE);
  assert.match(parsed.detail, /no row in fni\.product_catalog/);
});

test("a product the provider sent with no identifier is a fault, not a silence", () => {
  const c = classifyCoverage(
    [{ product_code: "", product_name: "Mystery Plan" }],
    SEEDED
  );
  assert.deepEqual(c.unmatched, [{ product_code: "", product_name: "Mystery Plan" }]);
  assert.equal(c.matched, 0);
});

test("an unrated session reports nothing rather than reporting a failure", () => {
  const c = classifyCoverage([], SEEDED);
  assert.deepEqual(c, { offered: 0, matched: 0, copy_pending: [], unmatched: [] });
});

test("store copy wins over tenant-wide copy for the same code", () => {
  const byCode = indexCatalog([
    { product_code: "VSC", display_name: "Tenant wording", store_id: null, is_presentable: true },
    { product_code: "VSC", display_name: "Store wording", store_id: STORE, is_presentable: true },
  ]);
  assert.equal(byCode.get("VSC").display_name, "Store wording");
  assert.equal(byCode.size, 1);
});

test("a tenant-wide row still counts as a match when no store row exists", () => {
  const byCode = indexCatalog([
    { product_code: "VSC", display_name: "Tenant wording", store_id: null, is_presentable: true },
  ]);
  const c = classifyCoverage([{ product_code: "VSC", product_name: "VSC" }], byCode);
  assert.equal(c.matched, 1);
  assert.deepEqual(c.unmatched, []);
});
