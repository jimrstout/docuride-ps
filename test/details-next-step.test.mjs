// Details: one main next step at a time, and plain names for each.
//
//   1. Not rated: Rate is the main button. No presentation buttons.
//   2. Rated, not prepared: Prepare presentation is the main button, Rate
//      again beside it, and Present menu and Present storyboard shown
//      disabled with "Prepare the presentation first."
//   3. Prepared: Present menu and Present storyboard are the main buttons;
//      Prepare presentation (to change it) and Rate again beside them.
//
// Renamed: Confirm and Continue is Rate, Prepare menu is Prepare
// presentation, Open presentation is Present storyboard. The addresses are
// unchanged. And Details fits one laptop screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextStep, PREPARE_FIRST, RATE_SAY } from "../apps/ownership-planner/lib/next-step.ts";
import { detailsSource } from "./details-source.mjs";

const app = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");
const page = detailsSource();
const footer = page.slice(page.indexOf('<footer className="vnext"'), page.indexOf("</footer>"));
/** The JSX of one step's branch in the footer's buttons. */
const doArea = footer.slice(footer.indexOf('<div className="vnext-do">'));
const rateBranch = doArea.slice(0, doArea.indexOf(") : ("));
const ratedBranch = doArea.slice(doArea.indexOf(") : ("));

test("the three steps, from the rating and the prepared record", () => {
  assert.equal(nextStep(false, false), "rate");
  assert.equal(nextStep(false, true), "rate", "prepared, but the rating is not current: rate first");
  assert.equal(nextStep(true, false), "prepare");
  assert.equal(nextStep(true, true), "present");
  assert.match(page, /const step = nextStep\(presentable, !!sheet\.prepared\);/);
});

test("1. not rated: Rate is the one button, and there is nothing to present", () => {
  assert.match(rateBranch, /\{step === "rate" \? \(/);
  assert.match(rateBranch, /<form action=\{verifyAndRateHere\} className="vgate" data-working-redraw="none">/);
  assert.match(rateBranch, /className="btn btn--go"[\s\S]*?>\s*Rate\s*<\/Control>/);
  for (const hidden of ["Present menu", "Present storyboard", "Prepare presentation", "/plan/", "/menu/", "/prepare/"]) {
    assert.ok(!rateBranch.includes(hidden), `${hidden} is not offered before a rating`);
  }
});

test("2. rated, not prepared: Prepare presentation leads; the presentations wait, saying why", () => {
  assert.match(ratedBranch, /className=\{step === "prepare" \? "btn btn--go" : "btn btn--quiet"\}\s*href=\{`\/prepare\/\$\{sessionId\}`\}/);
  const waiting = ratedBranch.slice(ratedBranch.indexOf('{step === "prepare" ? ('), ratedBranch.indexOf(") : (", ratedBranch.indexOf('{step === "prepare" ? (')));
  assert.match(waiting, /<Control className="btn btn--quiet" disabled aria-describedby="vnext-why">\s*Present menu\s*<\/Control>/);
  assert.match(waiting, /<Control className="btn btn--quiet" disabled aria-describedby="vnext-why">\s*Present storyboard\s*<\/Control>/);
  assert.match(waiting, /<p id="vnext-why" className="vnext-why">\{PREPARE_FIRST\}<\/p>/);
  assert.equal(PREPARE_FIRST, "Prepare the presentation first.");
  assert.doesNotMatch(waiting, /href=/, "nothing to open while waiting");
});

test("3. prepared: the two presentations lead, Prepare and Rate again beside them", () => {
  const live = ratedBranch.slice(ratedBranch.lastIndexOf(") : ("));
  // New tabs, through the shared control (components/Control.tsx, newTab).
  assert.match(live, /<Control className="btn btn--go" href=\{`\/menu\/\$\{sessionId\}`\} newTab>\s*Present menu\s*<\/Control>/);
  assert.match(live, /<Control className="btn btn--go" href=\{`\/plan\/\$\{sessionId\}`\} newTab>\s*Present storyboard\s*<\/Control>/);
});

test("Rate again is the secondary button whenever rated, and the old one under Rating is gone", () => {
  assert.match(ratedBranch, /rateAgainAvailable\(\{ signedIn: true, submitState: sheet\.submit_state \}\) \? \([\s\S]{0,400}?<form action=\{rateAgainHere\} className="vrate-again" data-working-redraw="none">/);
  assert.equal((page.match(/action=\{rateAgainHere\}/g) ?? []).length, 1);
  const status = page.slice(page.indexOf('<dl className="vstate">'), page.indexOf("</dl>"));
  assert.doesNotMatch(status, /rateAgain|Rate again/);
});

test("exactly one main button per step", () => {
  // Step 1's only go button is Rate; step 2's is Prepare (the class switch);
  // step 3's are the two presentations, which are one choice of where to present.
  assert.equal((rateBranch.match(/btn--go/g) ?? []).length, 1);
  const waiting = ratedBranch.slice(ratedBranch.indexOf('{step === "prepare" ? ('), ratedBranch.lastIndexOf(") : ("));
  assert.doesNotMatch(waiting, /btn--go/);
});

test("the rating sentence names no provider", () => {
  assert.equal(RATE_SAY, "Every required field has a value. Rating records your name, the time, and each value with its source.");
  assert.match(footer, /<p className="vgate-say">\{RATE_SAY\}<\/p>/);
  assert.doesNotMatch(footer, /\{vendor\}|sentenceStart\(vendor\)|provider_name/);
  assert.doesNotMatch(page, /Every field \{vendor\} asks for/);
});

test("the old names are gone from every screen, and the addresses stay", () => {
  const screens = [
    "app/details/[sessionId]/page.tsx", "app/details/[sessionId]/DetailsBody.tsx", "app/prepare/[sessionId]/page.tsx", "app/prepare/[sessionId]/Prepare.tsx",
    "app/admin/menus/page.tsx", "lib/submit-check.ts",
  ];
  for (const f of screens) {
    // Comments may tell the history; what is shown may not.
    const shown = app(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(shown, /Confirm and Continue|Open presentation|Prepare menu\b/, f);
  }
  assert.match(app("app/prepare/[sessionId]/Prepare.tsx"), /<p className="pm-eyebrow">Prepare presentation\{/);
  assert.match(app("app/prepare/[sessionId]/page.tsx"), /export const metadata = \{ title: "Prepare presentation" \};/);
  const sale = readFileSync(new URL("../supabase/functions/_shared/sale-date.ts", import.meta.url), "utf8");
  assert.doesNotMatch(sale, /Confirm and Continue/);
  const prep = readFileSync(new URL("../supabase/functions/fni-menu-prepare/index.ts", import.meta.url), "utf8");
  assert.match(prep, /Return to Prepare presentation to change them/);
});

test("Details fits one laptop screen: the page is the window, a long panel scrolls inside itself", () => {
  assert.match(page, /<div className="vh vh--fit">/);
  const css = app("app/globals.css");
  const fit = css.slice(css.indexOf("@media (min-width: 900px) and (min-height: 600px) {"));
  assert.match(fit, /\.vh--fit \{ height: 100vh; height: 100dvh; min-height: 0; display: flex; flex-direction: column; overflow: hidden; \}/);
  assert.match(fit, /\.vh--fit \.vtabs-panel \{ flex: 1 1 auto; min-height: 0; overflow: auto;/);
  assert.match(fit, /\.vh--fit \.vnext \{ flex: none;/);
  // The sheet in four columns, the vehicle across two.
  assert.match(fit, /grid-template-areas: "deal vehicle vehicle money" "customer vehicle vehicle money";/);
});

test("one panel at a time, each kept in the page so its forms still work", () => {
  const tabs = app("components/DetailsTabs.tsx");
  assert.match(tabs, /hidden=\{t\.id !== shown\}/);
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /sessionStorage\.setItem\(key, id\)/);
  for (const id of ['id: "sheet"', 'id: "parties"', 'id: "contracts"', 'id: "menu"']) assert.ok(page.includes(id), id);
  // The deal sheet form and the Save changes button that sends it are in the same panel.
  const sheetTab = page.slice(page.indexOf('id: "sheet"'), page.indexOf('id: "parties"'));
  assert.match(sheetTab, /id="vsheet"/);
  assert.match(sheetTab, /<Control type="submit" form="vsheet"/);
});
