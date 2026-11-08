// The Sessions list's store name (components/admin/StoreName.tsx): split at
// the first comma into the group and the place, for when two lines are not
// enough. Mock names only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// storeParts is plain code in a client component; read it out and run it.
const src = readFileSync(new URL("../apps/ownership-planner/components/admin/StoreName.tsx", import.meta.url), "utf8");
const body = src.match(/export function storeParts[\s\S]*?\n\}/)[0]
  .replace(/^export /, "").replace(/: string\): \{ group: string; place: string \} \| null/, ")");
const storeParts = new Function(`${body}; return storeParts;`)();

test("the place after the comma, the group before it", () => {
  assert.deepEqual(storeParts("Mock Powersports, Hilltop/Riverside"), { group: "Mock Powersports", place: "Hilltop/Riverside" });
  assert.deepEqual(storeParts("Mock Rides, Inc, Mocktown"), { group: "Mock Rides", place: "Inc, Mocktown" });
});

test("no comma, or nothing on one side: no split, the full name stands", () => {
  for (const n of ["Mock Chevrolet", ", Mocktown", "Mock Ford,", " , "]) assert.equal(storeParts(n), null, n);
});

test("the split shows the place in normal text and the group smaller and grey", () => {
  assert.match(src, /<span className="ad-store-place">\{parts\.place\}<\/span>\s*<small className="ad-store-group">\{parts\.group\}<\/small>/);
  assert.match(src, /getBoundingClientRect\(\)\.height > line \* 2 \+ 1/);
});
