// A new button without a busy state cannot be merged.
//
// Every clickable control goes through components/Control.tsx, which shows it
// is working when pressed. apps/ownership-planner/scripts/check-controls.mjs
// fails on any that does not: it runs before every `next build` (so a Vercel
// preview of the pull request fails) and here (so the GitHub workflow fails).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkApp, violations } from "../apps/ownership-planner/scripts/check-controls.mjs";

test("the app as it stands: every button and link goes through the shared control", () => {
  assert.deepEqual(checkApp(), []);
});

test("a bare button is rejected", () => {
  const v = violations(`export function X() {\n  return <button type="button">Save</button>;\n}\n`);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
  assert.match(v[0].say, /use <Control>/);
});

test("so are a bare link, Next's Link, an onClick, a submit input and a role=button stand-in", () => {
  const cases = {
    'return <a href="/details/x">Open</a>;': /<a> link/,
    'import Link from "next/link";': /Next's <Link>/,
    'return <Link href="/admin">Admin</Link>;': /Next's <Link>/,
    'return <div onClick={() => go()}>Go</div>;': /onClick/,
    'return <span onClick ={go}>Go</span>;': /onClick/,
    'return <input type="submit" value="Save" />;': /button <input>/,
    "return <input type='button' value='Go' />;": /button <input>/,
    'return <div role="button" tabIndex={0}>Go</div>;': /role="button"/,
  };
  for (const [code, say] of Object.entries(cases)) {
    const v = violations(code);
    assert.ok(v.some((x) => say.test(x.say)), code);
  }
});

test("the shared control itself, and comments, are not counted", () => {
  assert.deepEqual(violations("// a <button> used to be here, with onClick\n/* <a href> */\nconst x = 1;\n"), []);
  assert.deepEqual(violations('return <Control onPress={go}>Go</Control>;'), []);
  assert.deepEqual(violations('return <Control href="/details/x">Open</Control>;'), []);
  assert.deepEqual(violations('const url = "https://example.com/a"; // not a link'), []);
});

test("it runs before every build of the app", () => {
  const pkg = JSON.parse(readFileSync(new URL("../apps/ownership-planner/package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.prebuild, "node scripts/check-controls.mjs");
  assert.match(pkg.scripts.build, /next build/);
});
