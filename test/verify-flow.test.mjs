// The Verify flow after it was simplified: no sign-in, CRM always lands here,
// and Confirm and Continue comes back to Verify, which opens the presentation
// in its own tab.
//
// Mostly structural, over the source of the page, the server actions and
// fni-session-start. Each assertion is a thing that could regress quietly and
// either put a sign-in back in front of the CRM button, or let a verification be
// recorded with nobody's name on it, or reopen the exposure the session browser's
// login exists to close.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

const require_fs = () => ({ readdirSync, statSync });

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

/**
 * The text between two markers, insisting both exist.
 *
 * indexOf returning -1 silently produces a slice of the whole file, which reads
 * as a passing test right up until it reads as a failing one for the wrong
 * reason. This is what stops a renamed comment from quietly widening every
 * assertion below.
 */
function between(text, startMarker, endMarker) {
  const a = text.indexOf(startMarker);
  assert.ok(a >= 0, `marker not found: ${startMarker}`);
  const b = endMarker === null ? text.length : text.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, `end marker not found after ${startMarker}: ${endMarker}`);
  return text.slice(a, b);
}

/** One exported server action's body. */
function actionBody(name) {
  return between(actions, `export async function ${name}(`, "\n}\n");
}

const page = src("../apps/ownership-planner/app/details/[sessionId]/page.tsx");
const actions = src("../apps/ownership-planner/app/console-actions.ts");
const planPage = src("../apps/ownership-planner/app/plan/[sessionId]/page.tsx");
const sessionStart = src("../supabase/functions/fni-session-start/index.ts");

// ─────────────────────────────────────────────────────────────────────────
// 1. The CRM button opens Verify, every time
// ─────────────────────────────────────────────────────────────────────────

test("the launch URL is built in fni-session-start and nowhere else", () => {
  // Item 5's answer. Deluge opens whatever this returns, so this is the only
  // place that decides.
  assert.match(sessionStart, /function linksFor\(/);
  assert.match(sessionStart, /menu_url: `\$\{verifyBaseUrl\}\/\$\{sessionId\}`/);
});

test("every launch path returns the same links, so none can drift", () => {
  // Four returns: contracts already submitted, refresh failed, normal reopen,
  // and a brand new session. A literal menu_url on any of them would be a path
  // that still went straight to the presentation.
  assert.equal((sessionStart.match(/\.\.\.linksFor\(menuBaseUrl/g) ?? []).length, 4);
  assert.doesNotMatch(sessionStart, /menu_url: `\$\{menuBaseUrl\}/);
});

test("menu_url is the verify link and plan_url is kept separately", () => {
  const body = between(sessionStart, "function linksFor(", "\n}");
  assert.match(body, /verify_url: `\$\{verifyBaseUrl\}/);
  assert.match(body, /plan_url: `\$\{menuBaseUrl\.replace/);
  // And the resolved bases are echoed, because the secret cannot be read back.
  assert.match(body, /menu_base_url/);
  assert.match(body, /verify_base_url/);
});

test("the verify base is the plan base's sibling, with an override", () => {
  const fn = between(sessionStart, "function verifyBaseFrom(", "/** Both links for a session");
  assert.match(fn, /FNI_VERIFY_BASE_URL/);
  assert.match(fn, /\/plan\$\/i, "\/verify"/);
  assert.match(fn, /new URL\(trimmed\)\.origin/);
});

test("nothing skips Verify because the session was already verified", () => {
  // The old behaviour was implicit: menu_url was the presentation, so a verified
  // session went straight in. There must be no verification-state branch left in
  // the link building.
  const body = between(sessionStart, "function linksFor(", "\n}");
  assert.doesNotMatch(body, /verification_state|Verified/);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. No sign-in on the Verify flow
// ─────────────────────────────────────────────────────────────────────────

test("the verify page does not bounce a visitor to the sign-in", () => {
  assert.doesNotMatch(page, /if \(!operator\) redirect\("\/"\)/);
});

test("the verify actions that record a name take it from the sign-in (2026-11-02)", () => {
  // Details is signed in, and the Edge Functions check the sign-in on every
  // call (test/staff-sign-in-functions.test.mjs). The actions that put a name
  // on the record take it from the signed-in person.
  for (const name of ["saveVerifyFields", "verifyAndRate"]) {
    assert.match(actionBody(name), /await signedInInitials\(sessionId\)/, name);
  }
  assert.doesNotMatch(actions, /export async function setCheckerName/);
});

test("the verify screen is protected the same way the presentation is", () => {
  // Both routes take the session id out of the URL and validate its shape. That
  // unguessable id IS the security, and it is the same on both.
  assert.match(planPage, /isSessionId\(sessionId\)/);
  assert.match(page, /isSessionId\(sessionId\)/);
});

// ─────────────────────────────────────────────────────────────────────────
// What deliberately did NOT lose its sign-in
// ─────────────────────────────────────────────────────────────────────────

test("the session browser and settings still require a sign-in", () => {
  // They list twenty-five deals of buyer names, addresses and phone numbers.
  // That is a different exposure from one deal to whoever holds its link.
  for (const name of ["saveSettings", "rateSession"]) {
    assert.match(actionBody(name), /currentOperator/, `${name} must still need a sign-in`);
  }
});

test("voiding a contract and clearing unknown still require a sign-in", () => {
  // They reach TecAssured and undo real paperwork. A session link must not
  // authorise that.
  for (const name of ["voidContract", "clearSubmitUnknown"]) {
    assert.match(actionBody(name), /currentOperator/, `${name} must still need a sign-in`);
  }
  // And the screen itself is signed in, so there is no dead button to offer
  // a sign-in from (test/staff-sign-in.test.mjs).
  assert.match(page, /if \(!operator\) \{\s*return \(\s*<WorkingArea>\s*<SignIn/);
  assert.doesNotMatch(page, /Sign in to void/);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Confirm and Continue
// ─────────────────────────────────────────────────────────────────────────

test("the button says Rate (once Confirm and Continue)", () => {
  assert.match(page, />\s*Rate\s*<\/PendingButton>/);
  assert.doesNotMatch(page, /Confirm and Continue/);
  assert.doesNotMatch(page, /Verify and rate|Verify again and re-rate/);
});

test("confirming records the snapshot, rates, then returns to Verify", () => {
  const body = actionBody("verifyAndRate");

  const verifyAt = body.indexOf('action: "verify"');
  const rateAt = body.indexOf("adminRate");
  const backAt = body.indexOf("backToVerify(sessionId, rated");

  assert.ok(verifyAt > 0 && rateAt > verifyAt, "verify is recorded before rating");
  assert.ok(backAt > rateAt, "it returns to Verify after both");
  // The presentation opens in its own tab from the Verify screen, never from
  // this action.
  assert.doesNotMatch(body, /redirect\(`\/plan\//, "it must not send this tab to the planner");
});

test("a failed rate still returns to Verify with a flash, not an error page", () => {
  const body = actionBody("verifyAndRate");
  const catchAt = body.indexOf("catch (err)", body.indexOf("adminRate"));
  const backAt = body.indexOf("return backToVerify(sessionId, rated");
  assert.ok(catchAt > 0 && backAt > catchAt, "the rate failure is caught before returning");
  // Nothing between the catch and the return may throw or leave early.
  assert.doesNotMatch(body.slice(catchAt, backAt), /throw|return|redirect\(/);
  // The flash says so plainly, and says the presentation can still be opened.
  const flash = src("../apps/ownership-planner/lib/verify-flash.ts");
  assert.match(flash, /case "notrated"/);
  assert.match(flash, /You can still open the presentation/);
  assert.match(flash, /Verified and rated\. Open the presentation when you are ready/);
});

test("Present storyboard (once Open presentation) opens the plan in a new tab, with no handle back", () => {
  // A new tab, so this page stays where it was (navigation fixes, 2026-10-27).
  assert.match(page, /<a className="btn btn--go" href=\{`\/plan\/\$\{sessionId\}`\} target="_blank" rel="noopener">\s*Present storyboard\s*<\/a>/);
  assert.doesNotMatch(page, /Open presentation/);
  // Live only once verified, rated, current and prepared (2026-11-02), and the
  // planner still opens at step 1.
  assert.match(page, /presentable = verified && sheet\.rating\.state === "Rated" && !sheet\.rating\.out_of_date/);
  assert.match(page, /const step = nextStep\(presentable, !!sheet\.prepared\);/);
  const planner = src("../apps/ownership-planner/app/plan/[sessionId]/Planner.tsx");
  assert.match(planner, /const \[at, setAt\] = useState\(0\)/);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. A customer reopening their own link
// ─────────────────────────────────────────────────────────────────────────

test("the plan route never redirects a customer to Verify", () => {
  assert.doesNotMatch(planPage, /\/verify\//);
});

test("nothing in the planner links to Verify or the admin area", () => {
  // Every file under app/plan, not only the route: the planner must have no
  // way back to a staff screen, and the admin area is one.
  const { readdirSync, statSync } = require_fs();
  const root = new URL("../apps/ownership-planner/app/plan/", import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = new URL(name, dir);
      if (statSync(full).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (/\.(tsx?|mjs|js)$/.test(name)) files.push(full);
    }
  };
  walk(root);
  assert.ok(files.length >= 2, "found the planner's files");
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /["'`]\/admin/, `${f.pathname} must not link to /admin`);
    assert.doesNotMatch(text, /["'`]\/verify\//, `${f.pathname} must not link to /verify`);
  }
});

test("the planner still rates itself only once verified", () => {
  const planner = src("../apps/ownership-planner/app/plan/[sessionId]/Planner.tsx");
  assert.match(planner, /!== "Verified"\) return;/);
});

// ─────────────────────────────────────────────────────────────────────────
// Whose name goes on it
// ─────────────────────────────────────────────────────────────────────────

test("no name to type: the signed-in person is recorded, and nothing waits on a name", () => {
  // The Checked by box and its Change button are gone (2026-11-02).
  assert.doesNotMatch(page, /Checked by|checker_name|setCheckerName|currentChecker/);
  assert.doesNotMatch(actions, /checkerFor|CHECKER_COOKIE|needname|setCheckerName/);
  // Rate is disabled only for a sheet that cannot be rated, never for a name.
  assert.match(page, /disabled=\{!sheet\.ready\}/);
  // The signed-in person's initials, from the sign-in.
  assert.match(actions, /async function signedInInitials\(sessionId: string\): Promise<string> \{\s*const operator = await currentOperator\(\);\s*if \(!operator\) redirect\(`\/details\/\$\{sessionId\}`\);\s*return initialsFor\(operator\.email\);/);
  for (const name of ["saveVerifyFields", "verifyAndRate"]) {
    assert.match(actionBody(name), /const who = await signedInInitials\(sessionId\);/, name);
  }
  assert.match(actions, /verified_by: who/);
  assert.match(actions, /edited_by: who/);
  assert.match(actions, /confirmed_by: initialsFor\(operator\.email\)/);
});

test("the header shows who is signed in instead", () => {
  assert.match(page, /<span className="vh-me" title=\{operator\.email\}>\{initialsFor\(operator\.email\)\}<\/span>/);
});

test("a previously verified session says who verified it and when", () => {
  assert.match(page, /Verified by <b>\{sheet\.verification\.verified_by/);
  assert.match(page, /\{stamp\(sheet\.verification\.verified_at\)\}\./);
});
