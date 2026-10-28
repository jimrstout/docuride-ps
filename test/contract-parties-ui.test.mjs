// Who goes on the contracts, on Details (2026-10-28): the planner side.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as deno from "../supabase/functions/_shared/contract-parties.ts";
import { DX1_CONFIRMATION, DX1_REMINDER, PARTY_FIELD_NAMES, partyEntries } from "../apps/ownership-planner/lib/contract-parties.ts";
import { flashMessage } from "../apps/ownership-planner/lib/verify-flash.ts";

const src = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");

test("the planner's field names and sentences match the Deno side", () => {
  assert.deepEqual([...PARTY_FIELD_NAMES], [...deno.PARTY_KEYS]);
  assert.equal(DX1_REMINDER, deno.DX1_REMINDER);
  assert.equal(DX1_CONFIRMATION, deno.DX1_CONFIRMATION);
});

test("a save posts only the known fields, never form plumbing", () => {
  const fd = new Map([["buyer_last_name", "Sample"], ["$ACTION_ID_abc", "x"], ["session_id", "s"]]);
  assert.deepEqual(partyEntries({ get: (k) => fd.get(k) ?? null }), { buyer_last_name: "Sample" });
});

test("after a save the reminder to change DX1 is shown", () => {
  for (const code of ["partysaved", "partyremoved", "partyrestored", "partycrm"]) {
    assert.ok(flashMessage({ code, detail: null }).text.endsWith(DX1_REMINDER), code);
  }
  assert.equal(flashMessage({ code: "partykept", detail: null }).text, "Kept the staff value.");
});

test("the panels show to a signed-in operator only", () => {
  const page = src("app/details/[sessionId]/page.tsx");
  assert.match(page, /operator \? \(\s*<ContractParties parties=\{sheet\.contract_parties\} sessionId=\{sheet\.session\.id\} \/>/);
  assert.match(page, /Sign in to see and correct who goes on the contracts/);
  const actions = src("app/console-actions.ts");
  assert.match(actions, /if \(!operator\) return backToVerify\(sessionId, "refused", "Sign in to change who goes on the contracts\."\);/);
});

test("every field is editable, read-only when locked, with its history and the CRM's newer value", () => {
  const c = src("components/ContractParties.tsx");
  assert.match(c, /const editable = !parties\.locked;/);
  assert.match(c, /\{editable \? <Input field=\{field\} id=\{id\} \/> : <p className="vfield-value">/);
  assert.match(c, /Entered by Staff: \{field\.edited_by \?\? "unknown"\}, \{stamp\(field\.edited_at\)\}\. Was \{field\.was \?\? "not set"\}\./);
  assert.match(c, /CRM now says \{field\.crm_value \?\? "nothing"\}\./);
  assert.match(c, /<PendingButton pending="Keeping\.\.\.">Keep staff value<\/PendingButton>/);
  assert.match(c, /<PendingButton pending="Switching\.\.\.">Use CRM value<\/PendingButton>/);
  assert.match(c, /"Cash deal, no lienholder\."/);
  assert.match(c, /Business \{lower\(party\.party\)\}: <strong>/);
  assert.match(c, /<summary>Add a \{lower\(party\.party\)\}<\/summary>/);
  // Removing asks first, on the page and in the action.
  assert.match(c, /<input type="checkbox" name="confirm" value="1" required \/> Yes, remove the/);
  assert.match(src("app/console-actions.ts"), /if \(formData\.get\("confirm"\) !== "1"\) \{/);
  assert.match(c, /\{parties\.locked && parties\.lock_reason \? \(/);
});

test("the Submit confirmation appears only when something was edited", () => {
  // In the Submit modal now (components/SubmitConfirm.tsx, 2026-10-28).
  const page = src("app/details/[sessionId]/page.tsx");
  assert.match(page, /changes=\{sheet\.contract_parties\?\.changes \?\? \[\]\}/);
  const modal = src("components/SubmitConfirm.tsx");
  assert.match(modal, /const needsDx1 = changes\.length > 0;/);
  assert.match(modal, /\{needsDx1 \? \(\s*<label className="vdx1-confirm vconfirm-dx1">/);
  assert.match(modal, /name="dx1_confirmed"\s+value="1"\s+required/);
  assert.match(modal, /\{DX1_CONFIRMATION\}/);
  assert.match(src("components/SubmitSummary.tsx"), /<strong>\{ch\.label\}<\/strong>: \{ch\.was \?\? "not set"\} to \{ch\.now \?\? "removed"\}/);
  const actions = src("app/console-actions.ts");
  assert.match(actions, /\.\.\.\(formData\.get\("dx1_confirmed"\) === "1"\s*\? \{ dx1_confirmed: true, confirmed_by:/);
});

test("one column on a phone, side by side where there is room", () => {
  const css = src("app/globals.css");
  assert.match(css, /grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 20rem\), 1fr\)\);/);
  assert.match(css, /\.vparty-field \.vfield-value \{ overflow-wrap: anywhere; \}/);
});
