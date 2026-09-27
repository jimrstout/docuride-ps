// test/deploy-workflow.test.mjs
//
// The deploy workflow's two load-bearing decisions: which functions a change
// affects, and which ones CI must never touch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NEVER_DEPLOY,
  affected,
  closureOf,
  functionSlugs,
} from "../scripts/changed-edge-functions.mjs";

const WORKFLOW = readFileSync(
  new URL("../.github/workflows/deploy-edge-functions.yml", import.meta.url),
  "utf8"
);

/**
 * The workflow with its comments taken out.
 *
 * Needed because these assertions are about what the workflow DOES, and the
 * comments discuss the very things being forbidden: the file explains at length
 * why it passes no --no-verify-jwt flag and why it does not run `db push`. A test
 * that cannot tell an instruction from a sentence about one fails on prose
 * forever, which teaches everybody to delete the test.
 */
const INSTRUCTIONS = WORKFLOW.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

// ─── Which functions a change affects ────────────────────────────────────────

test("a change inside one function deploys only that function", () => {
  assert.deepEqual(
    affected(["supabase/functions/fni-vin-decode/index.ts"]),
    ["fni-vin-decode"]
  );
});

test("a shared module deploys every function that bundles it", () => {
  // The whole reason this is not a path-to-directory map. Each function carries
  // its own copy of the shared modules, so a function left undeployed keeps
  // running yesterday's shared code.
  const hit = affected(["supabase/functions/_shared/verification.ts"]);
  assert.deepEqual(hit, ["fni-session-start", "fni-session-verify"]);

  const viaMoney = affected(["supabase/functions/_shared/money.ts"]);
  assert.ok(viaMoney.includes("fni-acknowledgment"));
  assert.ok(viaMoney.includes("fni-rate-vehicle"));
  assert.ok(viaMoney.includes("fni-session-get"));
  assert.ok(
    viaMoney.length > hit.length,
    "money.ts reaches more functions than verification.ts"
  );
});

test("the closure follows imports more than one level deep", () => {
  // verification.ts imports finance-basis.ts, which imports money.ts. A function
  // that imports only verification.ts must still redeploy when money.ts moves.
  assert.ok(affected(["supabase/functions/_shared/money.ts"]).includes("fni-session-verify"));
});

test("a change outside supabase/functions deploys nothing", () => {
  assert.deepEqual(affected(["apps/ownership-planner/lib/edge.ts"]), []);
  assert.deepEqual(affected(["README.md", "test/verification.test.mjs"]), []);
});

test("config.toml deploys everything, because it carries verify_jwt", () => {
  const all = affected(["supabase/config.toml"]);
  const deployable = functionSlugs().filter((s) => !NEVER_DEPLOY.has(s));
  assert.deepEqual(all, deployable);
});

test("nothing changed means nothing deployed", () => {
  assert.deepEqual(affected([]), []);
  assert.deepEqual(affected(["", "  "]), []);
});

// ─── What must never deploy from here ────────────────────────────────────────

test("rr-report and admin-users are never deployed from this repository", () => {
  // They serve the live Reynolds and Reynolds system, and admin-users has no
  // source here at all.
  assert.ok(NEVER_DEPLOY.has("rr-report"));
  assert.ok(NEVER_DEPLOY.has("admin-users"));

  // Not even when somebody edits them.
  assert.deepEqual(affected(["supabase/functions/rr-report/index.ts"]), []);
  // Not even on the change that touches every other function.
  assert.ok(!affected(["supabase/config.toml"]).includes("rr-report"));
});

// ─── The workflow file itself ────────────────────────────────────────────────

test("the workflow never passes --no-verify-jwt", () => {
  // verify_jwt must come from config.toml alone. A flag here would silently
  // disagree with the file and win.
  assert.ok(!INSTRUCTIONS.includes("--no-verify-jwt"));
  // And the comment explaining why is still there, because the reason is the
  // part somebody about to add the flag needs.
  assert.match(WORKFLOW, /verify_jwt comes from/);
});

test("the workflow runs the tests before it deploys", () => {
  const testStep = INSTRUCTIONS.indexOf("npm test");
  const deployStep = INSTRUCTIONS.indexOf("supabase functions deploy");
  assert.ok(testStep > 0, "no npm test step");
  assert.ok(
    testStep < deployStep,
    "the tests must run before the deploy, or a red build still ships"
  );
});

test("the workflow does not run migrations", () => {
  // A migration can be irreversible. It should be a person deciding, not a side
  // effect of a merge.
  assert.ok(!INSTRUCTIONS.includes("db push"));
  assert.ok(!INSTRUCTIONS.includes("migration up"));
  assert.match(WORKFLOW, /does not run migrations/);
});

test("only main deploys, and only this repository", () => {
  assert.match(WORKFLOW, /branches: \[main\]/);
  assert.match(WORKFLOW, /github\.repository == 'jimrstout\/docuride-ps'/);
});

test("deploys do not run concurrently", () => {
  // Two overlapping runs can land in either order and the loser silently wins.
  assert.match(WORKFLOW, /group: deploy-edge-functions/);
  assert.match(WORKFLOW, /cancel-in-progress: false/);
});

test("no workflow expression is interpolated into a shell script body", () => {
  // The classic injection shape. Every ${{ }} belongs in an env: block.
  for (const line of WORKFLOW.split("\n")) {
    if (!line.includes("${{")) continue;
    assert.match(
      line,
      /^\s+[A-Za-z_][A-Za-z0-9_]*:\s+\$\{\{|^\s+if:\s/,
      `interpolated outside an env: block or an if:, which is where injection ` +
        `gets in: ${line.trim()}`
    );
  }
});

test("the missing-token message says where to get one", () => {
  assert.match(WORKFLOW, /SUPABASE_ACCESS_TOKEN is not set/);
  assert.match(WORKFLOW, /supabase\.com\/dashboard\/account\/tokens/);
});

// ─── The closure helper ──────────────────────────────────────────────────────

test("the closure ignores remote imports", () => {
  const closure = closureOf(
    new URL("../supabase/functions/fni-vin-decode/index.ts", import.meta.url).pathname
  );
  for (const f of closure) {
    assert.ok(!f.includes("http"), `remote specifier leaked into the closure: ${f}`);
    assert.ok(f.startsWith("supabase/functions/"), `not repo-relative: ${f}`);
  }
  assert.ok([...closure].some((f) => f.endsWith("_shared/tecassured.ts")));
});

test("_shared is not mistaken for a function", () => {
  assert.ok(!functionSlugs().includes("_shared"));
});
