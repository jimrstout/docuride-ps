// Checked by is gone; old sessions keep what it recorded.
//
// Every staff screen is signed in, so the Checked by box and its Change
// button only repeated the signed-in person. They are removed, nothing waits
// on a typed name, and every recorded action credits the signed-in person
// (test/staff-credit.test.mjs, test/verify-flow.test.mjs). Nothing is
// dropped: a session verified under a typed name still opens and shows it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const app = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");
const page = app("app/details/[sessionId]/page.tsx");

test("no Checked by box or Change button on any screen", () => {
  const roots = ["app", "components", "lib"];
  const walk = (dir) => readdirSync(new URL(`../apps/ownership-planner/${dir}/`, import.meta.url), { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(tsx?)$/.test(e.name) ? [`${dir}/${e.name}`] : []);
  for (const f of roots.flatMap(walk)) {
    // Comments may tell the history; nothing that runs or shows may name it.
    const src = app(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(src, /Checked by|checker_name|setCheckerName|className="vwho"/, f);
  }
  assert.equal(existsSync(new URL("../apps/ownership-planner/lib/checker.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("../apps/ownership-planner/lib/checker-name.ts", import.meta.url)), false);
});

test("rating signed in: no name prompt, and the name is the signed-in person's", () => {
  const footer = page.slice(page.indexOf('<footer className="vnext"'), page.indexOf("</footer>"));
  assert.doesNotMatch(footer, /Put your name|checker/);
  assert.match(footer, /disabled=\{!sheet\.ready\}/);
  assert.match(app("lib/presenter.ts"), /const name = nameFromEmail\(operator\.email\);/);
});

test("an old session with a Checked by name still opens and shows it", () => {
  // Verified by is printed exactly as stored: a typed name on an old session,
  // initials on a new one. Nothing transforms or hides it.
  assert.match(page, /Verified by <b>\{sheet\.verification\.verified_by \?\? "unknown"\}<\/b>/);
  assert.match(page, /\{sheet\.verification\.verified_by\}, \{stamp\(sheet\.verification\.verified_at\)\}/);
  // And the staff-edit history shows who changed each field, as stored.
  assert.match(page, /changed by ` \+\s*`\$\{field\.edited_by \?\? "unknown"\}/);
});
