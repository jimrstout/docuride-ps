// No em dashes in what a customer reads.
//
// House style, and a practical matter too: the planner is read on phones, often
// by people who are not native English readers, and an em dash asks the reader
// to hold a clause open. A full stop does not.
//
// This walks the customer-facing source rather than a list of strings, because
// the failure mode is somebody adding a NEW sentence with a dash in it, and a
// test that checks only today's sentences would never catch that.
//
// Comments are exempt. They are for us, they discuss the dashes among other
// things, and rewriting prose we wrote for each other buys nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../apps/ownership-planner/", import.meta.url).pathname;

/** What a customer's browser renders. The staff console is not in here. */
const CUSTOMER_FACING = ["components", "app/plan", "app/layout.tsx"];

const DASHES = /[—–]/;

function filesUnder(path) {
  const abs = join(ROOT, path);
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? filesUnder(join(path, e.name))
      : /\.tsx?$/.test(e.name) ? [join(abs, e.name)] : []
  );
}

/**
 * Strip comments so only renderable text is left.
 *
 * Order matters: block comments first, because a line comment marker inside a
 * block comment is not a line comment. Strings are not parsed out -- a dash
 * inside a string is exactly what this test is looking for.
 */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("no em or en dashes in customer-facing copy", () => {
  const offenders = [];

  for (const dir of CUSTOMER_FACING) {
    for (const file of filesUnder(dir)) {
      code(readFileSync(file, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          if (DASHES.test(line)) {
            offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Em dashes in customer-facing copy. Use a full stop or a comma:\n${offenders.join("\n")}`
  );
});

test("no em or en dashes in the staff console either", () => {
  // House style, not just customer-facing style. The console is read by people
  // under time pressure with a customer beside them, which is not the moment for
  // a clause held open.
  const STAFF = [
    "app/page.tsx", "app/settings", "app/admin", "components/admin",
    "app/verify", "app/console-actions.ts", "lib/admin-sections.ts",
  ];
  const offenders = [];

  for (const dir of STAFF) {
    for (const file of filesUnder(dir)) {
      code(readFileSync(file, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          if (DASHES.test(line)) {
            offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
  }

  assert.deepEqual(offenders, [], `Em dashes in console copy:\n${offenders.join("\n")}`);
});

test("the phrase that prompted this reads as two sentences", () => {
  const planner = readFileSync(join(ROOT, "app/plan/[sessionId]/Planner.tsx"), "utf8");
  assert.ok(planner.includes('"Saved. You can come back to this later."'));
  assert.ok(!planner.includes("Saved —"));
});

// ── And the customer is never told the machine has no plans by accident ────

test("the not-offered wording sits behind the Not Offered state alone", () => {
  const planner = readFileSync(join(ROOT, "app/plan/[sessionId]/Planner.tsx"), "utf8");

  // The sentence exists exactly once, on the "empty" screen.
  const matches = planner.match(/aren&apos;t offered on this type of machine/g) ?? [];
  assert.equal(matches.length, 1);

  // And "empty" is only ever chosen for Not Offered. Any other state, including
  // a rate that has not happened yet, gets the neutral screen.
  assert.ok(
    planner.includes('state === "Not Offered" ? "empty" : "unready"'),
    "the empty screen must be gated on the Not Offered state"
  );

  // The neutral screen says what it should and names no cause.
  assert.ok(planner.includes("We&apos;re still getting your options ready"));
  assert.ok(planner.includes("Your dealership will\n              help you with this step"));
});
