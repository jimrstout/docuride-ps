#!/usr/bin/env node
// scripts/changed-edge-functions.mjs
//
// Which Edge Functions a set of changed files actually affects.
//
// ── Why not just deploy all of them ──────────────────────────────────────────
// Two reasons. Deploying nineteen functions on a one-line change is slow and
// makes the deploy log useless for working out what shipped. And rr-report serves
// the live Reynolds and Reynolds system: redeploying it because somebody touched
// the Verify screen is a change to production that nobody asked for.
//
// ── Why not just map file to directory ───────────────────────────────────────
// Because of _shared. Each function carries its own bundled copy of the shared
// modules it imports, so editing _shared/verification.ts changes three deployed
// functions and editing _shared/money.ts changes six. A push that only redeployed
// the directory somebody edited would leave the rest running yesterday's shared
// code, which is the drift this whole arrangement exists to prevent.
//
// So the import graph is walked from every function's entrypoint, and a function
// is affected when the changed set touches its own directory or anything in its
// transitive closure.
//
// Usage:  node scripts/changed-edge-functions.mjs <changed-file> [...]
//         printf '%s\n' f1 f2 | node scripts/changed-edge-functions.mjs -
// Prints one function slug per line, or nothing.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const REPO = resolve(new URL("..", import.meta.url).pathname);
const FUNCTIONS = join(REPO, "supabase", "functions");

/**
 * Never deployed from this repository.
 *
 * rr-report and admin-users predate DocuRide PS and serve the live Reynolds and
 * Reynolds system. admin-users has no source here at all. Excluded by name rather
 * than by convention so that adding a function cannot quietly opt one of them in.
 */
export const NEVER_DEPLOY = new Set(["rr-report", "admin-users"]);

export function functionSlugs(root = FUNCTIONS) {
  return readdirSync(root)
    .filter((name) => name !== "_shared")
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort();
}

/** Every local file an entrypoint reaches, as repo-relative paths. */
export function closureOf(entrypoint, seen = new Set()) {
  let src;
  try {
    src = readFileSync(entrypoint, "utf8");
  } catch {
    return seen;
  }
  // Only relative specifiers. https:// imports are the runtime's problem.
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const target = normalize(join(dirname(entrypoint), m[1]));
    const rel = relative(REPO, target);
    if (!seen.has(rel)) {
      seen.add(rel);
      closureOf(target, seen);
    }
  }
  return seen;
}

/**
 * The functions a changed file list affects, excluding the ones CI must not touch.
 *
 * config.toml counts for all of them: it carries verify_jwt, so a change to it is
 * a change to how every function is deployed.
 */
export function affected(changed, root = FUNCTIONS) {
  const files = changed
    .map((f) => f.trim().replace(/^\.\//, ""))
    .filter((f) => f !== "");

  const configTouched = files.some((f) => f === "supabase/config.toml");

  const out = [];
  for (const slug of functionSlugs(root)) {
    if (NEVER_DEPLOY.has(slug)) continue;

    const own = `supabase/functions/${slug}/`;
    const closure = closureOf(join(root, slug, "index.ts"));

    const hit =
      configTouched ||
      files.some((f) => f.startsWith(own)) ||
      files.some((f) => closure.has(f));

    if (hit) out.push(slug);
  }
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const changed =
    args.length === 1 && args[0] === "-"
      ? readFileSync(0, "utf8").split("\n")
      : args;
  for (const slug of affected(changed)) console.log(slug);
}
