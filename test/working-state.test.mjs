// Making it obvious when the system is working (components/Working.tsx).
// The rules are in lib/working.ts; the sweep below holds every staff form to
// them, so a new form cannot quietly go back to looking idle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  jobFor, restoreFields, snapshotFields, STILL_WORKING, STILL_WORKING_AFTER_MS,
  SUBMIT_LEAVE, VOID_LEAVE, VEHICLE_TYPE_INTENT,
} from "../apps/ownership-planner/lib/working.ts";

const app = new URL("../apps/ownership-planner/", import.meta.url).pathname;
const src = (rel) => readFileSync(join(app, rel), "utf8");

test("the button first, then the form, says what an action is", () => {
  assert.deepEqual(jobFor({ working: "page", workingLabel: "Rating..." }, {}), { scope: "page", label: "Rating...", leave: null });
  assert.deepEqual(jobFor(null, { working: "panel", workingLabel: "Saving changes..." }), { scope: "panel", label: "Saving changes...", leave: null });
  assert.deepEqual(jobFor({ working: "page", workingLabel: "Voiding...", workingLeave: VOID_LEAVE }, { working: "panel" }), { scope: "page", label: "Voiding...", leave: VOID_LEAVE });
  assert.equal(jobFor(null, {}), null, "a form that says nothing is left alone (signing out)");
  assert.deepEqual(jobFor(null, { workingIntent: VEHICLE_TYPE_INTENT, working: "panel" }), { scope: "page", label: "Changing the vehicle type...", leave: null });
});

test("the wording is plain and the slow line comes at ten seconds", () => {
  assert.equal(STILL_WORKING_AFTER_MS, 10_000);
  assert.equal(STILL_WORKING, "Still working. This can take up to a minute.");
  assert.equal(SUBMIT_LEAVE, "Contracts are still being submitted. Leaving now may leave them half done.");
  for (const s of [STILL_WORKING, SUBMIT_LEAVE, VOID_LEAVE]) assert.doesNotMatch(s, /—/);
});

test("entries are kept and put back; hidden fields never", () => {
  const controls = [
    { name: "session_id", type: "hidden", value: "abc" },
    { name: "void_reason", type: "text", value: "Customer changed their mind" },
    { name: "confirm", type: "checkbox", value: "on", checked: true },
    { name: "vehicle_type", type: "radio", value: "UTV", checked: false },
    { name: "vehicle_type", type: "radio", value: "ATV", checked: true },
  ];
  const kept = snapshotFields(controls);
  assert.equal(kept.some((k) => k.name === "session_id"), false);
  const after = [
    { name: "session_id", type: "hidden", value: "abc" },
    { name: "void_reason", type: "text", value: "" },
    { name: "confirm", type: "checkbox", value: "on", checked: false },
    { name: "vehicle_type", type: "radio", value: "UTV", checked: true },
    { name: "vehicle_type", type: "radio", value: "ATV", checked: false },
  ];
  const changed = restoreFields(after, kept);
  assert.equal(after[1].value, "Customer changed their mind");
  assert.equal(after[2].checked, true);
  assert.equal(after[3].checked, false);
  assert.equal(after[4].checked, true);
  assert.equal(after[0].value, "abc");
  assert.equal(changed.length, 4);
});

function tsx(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === ".next") return [];
    return statSync(p).isDirectory() ? tsx(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

test("every staff form that waits on the server carries a Working marker", () => {
  const files = [...tsx(join(app, "app/details")), ...tsx(join(app, "app/admin")), ...tsx(join(app, "components"))];
  let forms = 0;
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/<form\b([^>]*?)>/gs)) {
      const attrs = m[1];
      if (/method="get"/.test(attrs) || /action=\{signOut\}/.test(attrs)) continue; // a search, and leaving
      if (!/action=\{/.test(attrs)) continue;
      forms++;
      const body = s.slice(m.index, s.indexOf("</form>", m.index));
      assert.match(body, /<Working \/>/, `${f}: ${attrs.trim().slice(0, 60)}`);
    }
  }
  assert.ok(forms >= 30, `found ${forms} forms`);
});

test("no staff form sends with a plain button: each says what it is doing", () => {
  const files = [...tsx(join(app, "app/details")), ...tsx(join(app, "app/admin")), "components/admin/SignIn.tsx"].map((f) => f.startsWith("/") ? f : join(app, f));
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/<form\b[^>]*action=\{(?!signOut)[^}]+\}[^>]*>([\s\S]*?)<\/form>/g)) {
      assert.doesNotMatch(m[1], /<button\s+type="submit"/, `${f}: a plain submit button`);
    }
  }
});

test("the whole-deal actions cover the page, Submit and Void warn before leaving", () => {
  const page = src("app/details/[sessionId]/page.tsx");
  for (const label of [
    "Refreshing from CRM...", "Submitting contracts...", "Voiding...", "Moving documents to the Deal Jacket...",
    "Confirming and rating...", "Decoding the VIN...", "Reloading from CRM...",
  ]) {
    assert.match(page, new RegExp(`working="page"[^>]*pending="${label.replace(/\./g, "\\.")}"`), label);
  }
  assert.match(page, /pending="Submitting contracts\.\.\." leave=\{SUBMIT_LEAVE\}/);
  assert.equal((page.match(/pending="Voiding\.\.\." leave=\{VOID_LEAVE\}/g) ?? []).length, 2);
  // Smaller ones lock their panel.
  assert.match(page, /<PendingButton pending="Getting the document\.\.\.">/);
  assert.match(page, /data-working-panel=""/);
  // A vehicle type change is a whole-deal change.
  assert.match(src("components/VehicleTypeChoice.tsx"), /form\.dataset\.workingIntent = VEHICLE_TYPE_INTENT;/);
  // Every staff page is inside a working area.
  assert.match(page, /<WorkingArea>/);
  assert.match(src("app/admin/layout.tsx"), /<WorkingArea>\s*<div className="ad">/);
  // The admin +24h locks its own row's actions; Rate covers the page.
  const sessions = src("app/admin/sessions/page.tsx");
  assert.match(sessions, /<div className="ad-actions" data-working-panel="">/);
  assert.match(sessions, /working="page" pending="Rating\.\.\."/);
});

test("the area blocks other sends, locks, warns, announces and keeps entries", () => {
  const w = src("components/Working.tsx");
  assert.match(w, /addEventListener\("submit", onSubmit, true\)/);
  assert.match(w, /e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);/);
  assert.match(w, /inert=\{page \|\| undefined\}/);
  assert.match(w, /aria-busy=\{page \|\| undefined\}/);
  assert.match(w, /panel\.inert = true;/);
  assert.match(w, /window\.addEventListener\("beforeunload", onLeave\)/);
  assert.match(w, /role="status" aria-live="polite"/);
  assert.match(w, /restoreFields\(/);
  // Never times out silently: after two minutes it says so and offers a reload.
  assert.match(w, /This is taking longer than it should\. Reload the page to see where it got to\./);
  // Results the page draws are what it shows.
  assert.match(src("app/details/[sessionId]/page.tsx"), /data-working-result=\{flash\.tone\}/);
  assert.match(src("components/admin/Parts.tsx"), /data-working-result=\{tone === "good" \? "ok" : "bad"\}/);
});

test("the customer's menu holds still while a choice saves, and accepts once", () => {
  const p = src("app/plan/[sessionId]/Planner.tsx");
  assert.match(p, /if \(finishing\.current\) return;\s*finishing\.current = true;/);
  assert.match(p, /if \(ackState === "working"\) return;/);
  assert.match(p, /nextDisabled=\{undecidedHere \|\| ackState === "working"\}/);
  assert.match(p, /inert=\{saveState === "saving" \|\| undefined\}/);
  assert.match(p, /One moment\.\.\./);
  // Staff wording never reaches the customer.
  assert.doesNotMatch(p, /WorkingArea|Submitting contracts/);
});
