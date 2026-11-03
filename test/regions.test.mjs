// Oregon, next to the database (Supabase project in us-west-2): the PS server
// runs in Vercel's pdx1, and every Edge Function it calls runs in us-west-2.
// Before this the server ran in iad1 and the functions it called in us-east-1,
// so each of their database reads crossed the country.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("the PS server runs in Oregon", () => {
  const config = JSON.parse(read("apps/ownership-planner/vercel.json"));
  assert.deepEqual(config.regions, ["pdx1"]);
});

test("every Edge Function call asks for Oregon", () => {
  const edge = read("apps/ownership-planner/lib/edge.ts");
  assert.match(edge, /export const FUNCTION_REGION = "us-west-2";/);
  assert.match(edge, /"x-region": FUNCTION_REGION,/);
  // One fetch to the functions, so the header covers every call.
  assert.equal((edge.match(/await fetch\(/g) ?? []).length, 1);
});

test("the root project (marketing and the R&R relay) is not changed", () => {
  const root = JSON.parse(read("vercel.json"));
  assert.equal(root.regions, undefined);
});
