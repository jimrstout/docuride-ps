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
import { detailsSource } from "./details-source.mjs";

const app = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");
const fn = (name) => readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");

test("caught up only once a different render is on the screen", () => {
  assert.equal(caughtUp("a", "a"), false, "the answer has not been drawn yet");
  assert.equal(caughtUp("a", "b"), true, "the new render is on the screen");
  // A marker that has merely gone is not the answer: Next can show an empty
  // page between the old page and the new one (seen with slowed answers).
  assert.equal(caughtUp("a", null), false, "the old page has gone but the new one is not drawn yet");
  assert.equal(caughtUp(null, null), true, "a page with no marker ends as it always did");
  assert.equal(RENDER_STAMP_ATTR, "data-working-render");
  assert.ok(RENDER_WAIT_MS >= 60_000, "never ends early for a slow rate");
});

test("Details carries the marker, new on every render, made on the server", () => {
  const stamp = app("components/RenderStamp.tsx");
  assert.doesNotMatch(stamp, /"use client"/);
  assert.match(stamp, /randomUUID\(\)/);
  // Last in the page, so it changes only once everything above it is drawn.
  const page = detailsSource();
  // Drawn by the server page and placed last in the body (DetailsBody.tsx).
  assert.match(page, /renderStamp=\{[\s\S]*?<RenderStamp \/>\s*\}/);
  assert.match(page, /<\/main>\s*\{\/\*[\s\S]*?\*\/\}\s*\{renderStamp\}\s*<\/div>\s*<\/WorkingArea>/);
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
  // Rate again updates the page from its answer and has no render to wait for (speed part 2).
  assert.match(w, /renderBefore: form\.dataset\.workingRedraw === "none" \? null : renderStamp\(\),/);
  // finish() ends once however many markers call it (r.finishing).
  assert.match(w, /if \(!r \|\| r\.finishing\) return;\s*r\.finishing = true;/);
  assert.match(wait, /r\.waiting = true;/);
});

test("the double-submit guards are unchanged: on the page and on the server", () => {
  const w = app("components/Working.tsx");
  assert.match(w, /if \(state\.running\) \{[\s\S]*?e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);/);
  assert.match(app("components/Control.tsx"), /disabled=\{disabled \|\| busy\}/);
  assert.match(fn("fni-contract-submit"), /submit_state/);
  assert.match(fn("fni-contract-void"), /claim/i);
});

test("Details' actions refresh the page in place, so it never goes blank", () => {
  // A redirect to the page already showing made Next draw an empty window
  // until the new page's data arrived, seconds with the overlay gone.
  const actions = readFileSync(new URL("../apps/ownership-planner/app/console-actions.ts", import.meta.url), "utf8");
  const back = actions.slice(actions.indexOf("async function backToVerify("), actions.indexOf("\n}\n", actions.indexOf("async function backToVerify(")));
  assert.match(back, /\): Promise<void> \{/);
  assert.match(back, /revalidatePath\(`\/details\/\$\{sessionId\}`\);/);
  assert.doesNotMatch(back, /redirect\(/);
  // And a link into Details shows a busy screen, never a blank one, while it loads.
  const loading = readFileSync(new URL("../apps/ownership-planner/app/details/[sessionId]/loading.tsx", import.meta.url), "utf8");
  assert.match(loading, /data-page-loading=""/);
  assert.match(loading, /Loading the deal\.\.\./);
});
