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
import { normalizeOffer } from "../supabase/functions/_shared/planner-offers.ts";
import { RATED_OFFER_RESPONSE } from "./fixtures/rated-offer.mjs";

const STORE = "7428435c";

function row(code, opts = {}) {
  return {
    product_code: code,
    display_name: opts.display_name ?? code,
    store_id: opts.store_id ?? STORE,
    is_presentable: opts.is_presentable ?? true,
  };
}

/** The seeded catalog: four written, PPM registered with its copy unwritten. */
const SEEDED = indexCatalog([
  row("VSC", { display_name: "Vehicle Service Contract" }),
  row("GAP", { display_name: "Guaranteed Asset Protection" }),
  row("TW", { display_name: "Tire and Wheel Protection" }),
  row("KEY", { display_name: "Key and Remote Replacement" }),
  row("PPM", { display_name: "Planned Maintenance", is_presentable: false }),
]);

const OFFERED = normalizeOffer(RATED_OFFER_RESPONSE).map((p) => ({
  product_code: p.product_code,
  product_name: p.product_name,
}));

test("the seeded offer matches every product it rates", () => {
  const c = classifyCoverage(OFFERED, SEEDED);
  assert.equal(c.offered, 5);
  assert.equal(c.matched, 5);
  assert.deepEqual(c.unmatched, [], "nothing should be unmatched against the seed");
});

test("a product whose copy is unwritten is withheld, and says so", () => {
  const c = classifyCoverage(OFFERED, SEEDED);
  assert.deepEqual(c.copy_pending, [
    { product_code: "PPM", display_name: "Planned Maintenance" },
  ]);
});

// The assertion this whole change exists for.
test("an unrecognised product is not reported as a withheld one", () => {
  const withoutPpm = indexCatalog(
    [...SEEDED.values()].filter((r) => r.product_code !== "PPM")
  );
  const c = classifyCoverage(OFFERED, withoutPpm);

  // PPM now has no row at all, so it is a join failure, not a decision.
  assert.deepEqual(c.unmatched, [
    { product_code: "PPM", product_name: "Planned Maintenance" },
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
    indexCatalog([...SEEDED.values()].filter((r) => r.product_code !== "PPM"))
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
  assert.equal(c.unmatched.length, 5);
  assert.equal(c.copy_pending.length, 0, "none of this is a copy decision");

  const report = joinFailureReport("sess-1", STORE, c, numeric.map((p) => p.product_code));
  const parsed = JSON.parse(report);
  assert.deepEqual(parsed.unmatched_codes, ["90001", "90002", "90003", "90004", "90005"]);
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
