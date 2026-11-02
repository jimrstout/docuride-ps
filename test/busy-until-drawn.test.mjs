// The busy state stays up until the answer is on the screen.
//
// Details' actions answer by redirecting back to Details. The busy state used
// to end when the page "settled": changed and then quiet for 400 ms, or
// unchanged for 1.5 s. Either can come before the new page is drawn, and the
// spinner went away while the old figures were still showing, which invited a
// second press. Now Details carries a hidden marker that is new on every
// server render, and the busy state (spinner, overlay, disabled buttons) ends
// only once a different marker is on the page. The server's own guards against
// a second submit or void are unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { caughtUp, RENDER_STAMP_ATTR, RENDER_WAIT_MS } from "../apps/ownership-planner/lib/working.ts";

const app = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");
const fn = (name) => readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");

test("caught up only once a different render is on the screen", () => {
  assert.equal(caughtUp("a", "a"), false, "the answer has not been drawn yet");
  assert.equal(caughtUp("a", "b"), true, "the new render is on the screen");
  assert.equal(caughtUp("a", null), true, "the page was replaced (an error page): nothing more to wait for");
  assert.equal(caughtUp(null, null), true, "a page with no marker ends as it always did");
  assert.equal(RENDER_STAMP_ATTR, "data-working-render");
  assert.ok(RENDER_WAIT_MS >= 60_000, "never ends early for a slow rate");
});

test("Details carries the marker, new on every render, made on the server", () => {
  const stamp = app("components/RenderStamp.tsx");
  assert.doesNotMatch(stamp, /"use client"/);
  assert.match(stamp, /randomUUID\(\)/);
  assert.match(app("app/details/[sessionId]/page.tsx"), /<div className="vh vh--fit">[\s\S]{0,300}<RenderStamp \/>/);
});

test("the busy state waits for the marker, and keeps its slow and stuck messages meanwhile", () => {
  const w = app("components/Working.tsx");
  const finish = w.slice(w.indexOf("function finish()"), w.indexOf("// ── The area"));
  const wait = finish.slice(finish.indexOf("if (r.renderBefore !== null) {"), finish.indexOf("for (const t of timers) clearTimeout(t);\n  timers = [];\n", finish.indexOf("return;\n  }")));
  // Nothing ends it but the new render (or the long give-up).
  assert.match(wait, /if \(done \|\| !caughtUp\(r\.renderBefore, renderStamp\(\)\)\) return;/);
  assert.doesNotMatch(wait, /QUIET_MS|NOTHING_CHANGED_MS/);
  assert.match(wait, /setTimeout\(\(\) => \{\s*r\.renderBefore = null;\s*settle\(\);\s*\}, RENDER_WAIT_MS\)/);
  // The "still working" and stuck timers are cleared only once it ends.
  assert.ok(finish.indexOf("if (r.renderBefore !== null) {") < finish.indexOf("for (const t of timers) clearTimeout(t);"));
  // Remembered when the action starts, and a second "the form ended" changes nothing.
  assert.match(w, /renderBefore: renderStamp\(\),/);
  assert.match(wait, /if \(r\.waiting\) return;\s*r\.waiting = true;/);
});

test("the double-submit guards are unchanged: on the page and on the server", () => {
  const w = app("components/Working.tsx");
  assert.match(w, /if \(state\.running\) \{[\s\S]*?e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);/);
  assert.match(app("components/PendingButton.tsx"), /disabled=\{disabled \|\| busy\}/);
  assert.match(fn("fni-contract-submit"), /submit_state/);
  assert.match(fn("fni-contract-void"), /claim/i);
});
