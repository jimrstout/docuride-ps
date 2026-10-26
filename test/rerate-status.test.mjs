// A re-rate does not send a session back from Products Selected to Rated
// while every product the customer took is still offered at the same rate
// (fix 4d). Rate ids are stable across quotes: on deal 13437 the Theft (1448)
// and Battery (34347) rates chosen at 17:13 were in the 18:53 quote.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { choicesStillOffered, rateKey, statusAfterRating } from "../supabase/functions/_shared/rerate.ts";

const TA = "21bec05b";
const chosen = [
  { provider_id: TA, provider_product_id: "24_5", rate_unique_id: "1448" },
  { provider_id: TA, provider_product_id: "755_6", rate_unique_id: "34347" },
];
const offered = new Set([rateKey(TA, "24_5", "1448"), rateKey(TA, "755_6", "34347"), rateKey(TA, "22_4", "9")]);

test("choices still offered at the same rate keep the session where it was", () => {
  assert.equal(choicesStillOffered(chosen, offered, new Set()), true);
  assert.equal(statusAfterRating("Products Selected", 9, true), "Products Selected");
});

test("a choice no longer offered, or offered at another rate, sends it back to Rated", () => {
  const moved = new Set([rateKey(TA, "24_5", "1448"), rateKey(TA, "755_6", "99999")]);
  assert.equal(choicesStillOffered(chosen, moved, new Set()), false);
  assert.equal(statusAfterRating("Products Selected", 9, false), "Rated");
  // Another provider's identical ids do not count.
  assert.equal(choicesStillOffered(chosen, new Set([rateKey("other", "24_5", "1448"), rateKey("other", "755_6", "34347")]), new Set()), false);
});

test("a provider whose current offers were kept still offers what it did", () => {
  assert.equal(choicesStillOffered(chosen, new Set(), new Set([TA])), true);
});

test("before any choice, a rating makes the session Rated; nothing offered leaves it alone", () => {
  assert.equal(statusAfterRating("Initiated", 9, true), "Rated");
  assert.equal(statusAfterRating("Rated", 9, true), "Rated");
  assert.equal(statusAfterRating("Products Selected", 0, false), "Products Selected");
  assert.equal(statusAfterRating("Initiated", 0, true), "Initiated");
  // No choices at all (every product declined) is trivially still offered.
  assert.equal(choicesStillOffered([], new Set(), new Set()), true);
});

test("fni-rate-vehicle writes and answers the same status, from the Included choices", () => {
  const rv = readFileSync(new URL("../supabase/functions/fni-rate-vehicle/index.ts", import.meta.url), "utf8");
  assert.match(rv, /\.from\("selected_products"\)\s+\.select\("provider_id, provider_product_id, rate_unique_id"\)\s+\.eq\("session_id", session_id\)\s+\.eq\("disposition", "Included"\)/);
  assert.equal((rv.match(/status: nextStatus,/g) ?? []).length, 2);
  assert.doesNotMatch(rv, /status: "Rated",/);
});
