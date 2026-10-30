// Products already purchased on a deal (2026-10-30). Adding products after a
// contract is the accepted model: a product under a live contract shows as
// purchased and locked on the Ownership Planner, and everything not yet
// submitted stays selectable. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FINALIZED,
  PRODUCTS_SELECTED,
  finalizedMaySave,
  isPurchased,
  purchasedKeys,
  splitLocked,
  statusAfterAdding,
} from "../supabase/functions/_shared/purchased.ts";
import {
  PURCHASED_LABEL,
  PURCHASED_NOTE,
  purchasedSet,
  purchasedTierOf,
  savedPrice,
} from "../apps/ownership-planner/lib/purchased.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const P = "11111111-1111-4111-8111-111111111111";

const contracts = [
  { provider_id: P, provider_product_id: "BATT", status: "Live" },
  { provider_id: P, provider_product_id: "TIRE", status: "Submit Status Unknown" },
  { provider_id: P, provider_product_id: "CARE", status: "Voided" },
];

test("a Live or Submit Status Unknown contract holds its product; a voided one does not", () => {
  const bought = purchasedKeys(contracts);
  assert.equal(isPurchased(bought, P, "BATT"), true);
  assert.equal(isPurchased(bought, P, "TIRE"), true);
  assert.equal(isPurchased(bought, P, "CARE"), false);
  // The same code from another provider is another product.
  assert.equal(isPurchased(bought, "22222222-2222-4222-8222-222222222222", "BATT"), false);
});

test("a save never rewrites a purchased product's row, and writes the rest", () => {
  const decisions = [
    { product_code: "BATT", disposition: "Managed by Customer" },
    { product_code: "CARE", disposition: "Included" },
    { product_code: "MAINT", disposition: "Included" },
  ];
  const { writable, locked } = splitLocked(decisions, purchasedKeys(contracts), () => P);
  assert.deepEqual(locked.map((d) => d.product_code), ["BATT"]);
  assert.deepEqual(writable.map((d) => d.product_code), ["CARE", "MAINT"]);
  const save = read("supabase/functions/fni-session-save/index.ts");
  assert.match(save, /const \{ writable, locked \} = splitLocked\(decisions, purchased, providerOf\);/);
  assert.match(save, /if \(writable\.length > 0\) \{\s*const rows = writable\.map\(/);
  assert.match(save, /locked: locked\.map\(\(d\) => String\(d\.product_code\)\),/);
});

test("a Finalized session saves while a contract is live, and goes back to Products Selected for a new product", () => {
  assert.equal(finalizedMaySave(FINALIZED, purchasedKeys(contracts)), true);
  assert.equal(finalizedMaySave(FINALIZED, new Set()), false);
  assert.equal(finalizedMaySave("Agreement Created", new Set()), true);
  assert.equal(statusAfterAdding(FINALIZED, true, 1), PRODUCTS_SELECTED);
  // Nothing new included, or not finished: the status stays.
  assert.equal(statusAfterAdding(FINALIZED, true, 0), null);
  assert.equal(statusAfterAdding(FINALIZED, false, 2), null);
  assert.equal(statusAfterAdding("Agreement Created", true, 1), null);
  const save = read("supabase/functions/fni-session-save/index.ts");
  assert.match(save, /if \(TERMINAL\.includes\(s\.status\) && !\(s\.status === "Finalized" && finalizedMaySave\(s\.status, purchased\)\)\) \{/);
  assert.match(save, /writable\.filter\(\(d\) => d\.disposition === "Included"\)\.length/);
  // Written Back and Cancelled still refuse.
  assert.match(save, /const TERMINAL = \["Finalized", "Written Back", "Cancelled"\];/);
});

test("Submit is unchanged: it already sends only products with no live contract", () => {
  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /const allowed = \["Rated", "Presenting", "Products Selected", "Agreement Created"\];/);
  assert.doesNotMatch(submit, /purchased\.ts/);
});

test("the customer's tab is told what is purchased, with no contract number", () => {
  const get = read("supabase/functions/fni-session-get/index.ts");
  assert.match(get, /\.select\("provider_id, provider_product_id, status"\)/);
  assert.match(get, /\.map\(\(c\) => \(\{ provider_id: c\.provider_id, provider_product_id: String\(c\.provider_product_id\) \}\)\);/);
  assert.match(get, /selections: selections \?\? \[\],\s*purchased,/);
});

test("the planner locks a purchased family to its tier, included, at the price it was sold for", () => {
  const bought = purchasedSet([{ provider_id: P, provider_product_id: "CARE-GOLD" }]);
  const family = {
    provider_id: P,
    tiers: [{ tier: { product_code: "CARE-SILVER" } }, { tier: { product_code: "CARE-GOLD" } }],
  };
  assert.equal(purchasedTierOf(family, bought)?.tier.product_code, "CARE-GOLD");
  assert.equal(purchasedTierOf({ ...family, tiers: [family.tiers[0]] }, bought), null);
  assert.equal(savedPrice({ customer_price: "1234.56", retail_price: "999" }), 1234.56);
  assert.equal(savedPrice({ customer_price: null, retail_price: 999 }), 999);
  assert.equal(savedPrice(undefined), null);

  const planner = read("apps/ownership-planner/app/plan/[sessionId]/Planner.tsx");
  assert.match(planner, /purchasedTierOf\(p, purchased\) \?\?\s*p\.tiers\.find\(\(t\) => t\.tier\.product_code === tierChoice\[p\.family_code\]\)/);
  assert.match(planner, /\(lockedOf\(p\) \? "Included" : decisions\[p\.family_code\]\)/);
  assert.match(planner, /if \(lockedOf\(p\)\) \{\s*const sold = savedPrice\(/);
  // Every decision on the screens goes through decisionOf, so a locked one reads Included.
  assert.equal((planner.match(/decisions\[p\.family_code\]/g) ?? []).length, 1);
});

test("a purchased product shows no choices, only that it is purchased", () => {
  const screen = read("apps/ownership-planner/components/ProductScreen.tsx");
  assert.equal((screen.match(/\{purchased \? null : \(/g) ?? []).length, 2);
  assert.match(screen, /\{purchased \? \(\s*<div className="ps-decide ps-purchased" role="status">\s*<p className="ps-purchased-label">\{PURCHASED_LABEL\}<\/p>/);
  assert.equal(PURCHASED_LABEL, "Purchased");
  assert.equal(PURCHASED_NOTE, "This is already on your contract, so it can't be changed here.");
  for (const s of [PURCHASED_LABEL, PURCHASED_NOTE]) assert.doesNotMatch(s, /—/);
});
