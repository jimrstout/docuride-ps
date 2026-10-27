// Every control that opens a customer's menu opens it in a new tab, so the
// staff page stays where it was and one person can work several deals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../apps/ownership-planner/", import.meta.url).pathname;

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === ".next") return [];
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

test("every link to a /plan/ page opens a new tab with rel=noopener", () => {
  let found = 0;
  for (const f of [...files(join(root, "app")), ...files(join(root, "components"))]) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/<(a|Link)\b[^>]*?href=\{`\/plan\/[^>]*>/gs)) {
      found++;
      assert.match(m[0], /target="_blank"/, `${f}: ${m[0]}`);
      assert.match(m[0], /rel="noopener"/, `${f}: ${m[0]}`);
    }
  }
  assert.ok(found >= 2, `expected the sessions list and the deal page, found ${found}`);
});
