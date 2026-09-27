// test/edge-function-config.test.mjs
//
// supabase/config.toml must name every Edge Function.
//
// ── The bug this prevents ─────────────────────────────────────────────────────
// `supabase functions deploy` reads verify_jwt from config.toml and DEFAULTS TO
// TRUE. So a function missing from that file is not left alone by a CLI deploy:
// it is switched to requiring a Supabase JWT. Every function in this project
// authenticates with FNI_WEBHOOK_SECRET instead, checked inside the handler, so
// the switch turns every call into a 401 before the handler runs.
//
// Thirteen of nineteen were missing when the deploy workflow was written. The
// first CLI deploy would have taken the Verify screen, the planner, the CRM
// button and both cron jobs off the air together. Nothing had broken only because
// every deploy until then went through the Management API, which leaves the
// existing setting alone.
//
// A missing line is invisible until the moment it does damage, which is exactly
// what a test is for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../supabase/", import.meta.url).pathname;
const CONFIG = readFileSync(join(ROOT, "config.toml"), "utf8");

/** Function directories in the repo. `_shared` is modules, not a function. */
function functionDirs() {
  const dir = join(ROOT, "functions");
  return readdirSync(dir)
    .filter((name) => name !== "_shared")
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/** `[functions.<slug>]` sections, in file order. */
function declared() {
  return [...CONFIG.matchAll(/^\[functions\.([^\]]+)\]/gm)].map((m) => m[1]);
}

test("every function directory is declared in config.toml", () => {
  const missing = functionDirs().filter((f) => !declared().includes(f));
  assert.deepEqual(
    missing,
    [],
    `These functions have no [functions.<name>] section, so a CLI deploy would ` +
      `switch them to verify_jwt = true and 401 every caller: ${missing.join(", ")}`
  );
});

test("config.toml declares nothing that does not exist", () => {
  // A stale entry is harmless but misleading: it reads as though something is
  // deployed from here when it is not.
  const extra = declared().filter((f) => !functionDirs().includes(f));
  assert.deepEqual(extra, [], `Declared with no source in this repo: ${extra.join(", ")}`);
});

test("every declaration sets verify_jwt explicitly", () => {
  // Present-but-empty is the same trap as absent: the default applies.
  for (const slug of declared()) {
    const section = CONFIG.split(`[functions.${slug}]`)[1] ?? "";
    const upToNext = section.split(/^\[/m)[0];
    assert.match(
      upToNext,
      /verify_jwt\s*=\s*(true|false)/,
      `[functions.${slug}] does not set verify_jwt`
    );
  }
});

test("every fni function verifies no JWT, because none of them receive one", () => {
  // They authenticate with FNI_WEBHOOK_SECRET, checked in the handler. If one of
  // these ever flips to true, the thing that broke is a login nobody can perform:
  // Zoho's webhook builder cannot attach a Supabase JWT and pg_net does not
  // either.
  for (const slug of declared().filter((s) => s.startsWith("fni-") || s.startsWith("zoho-"))) {
    const section = (CONFIG.split(`[functions.${slug}]`)[1] ?? "").split(/^\[/m)[0];
    assert.match(section, /verify_jwt\s*=\s*false/, `${slug} must not require a JWT`);
  }
});

test("rr-report keeps the JWT it has always required", () => {
  // The live Reynolds and Reynolds report. Recorded as true because that is what
  // the deployed function says, read off the project on 2026-09-27 -- not because
  // it is the CLI default. CI excludes it from deploys either way.
  const section = (CONFIG.split("[functions.rr-report]")[1] ?? "").split(/^\[/m)[0];
  assert.match(section, /verify_jwt\s*=\s*true/);
});
