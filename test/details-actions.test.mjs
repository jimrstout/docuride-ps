// Details actions that update the page from their own answer (7 Nov 2026):
// Save changes, Discard my edits, Refresh from CRM, the coverage levels, the
// buyer, co-buyer and lienholder actions, and Decode the VIN. Each drew the
// whole page again after it, which reads the deal (fni-session-verify GET,
// 2.7 s typical and up to 13.8 s) and runs the DX1 check, and could leave
// the busy state up for 90 seconds when Next dropped that redraw (#148,
// deal 07982). Now each answers with the whole sheet a reload would show,
// and Details puts it up in place. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sheetFromReply } from "../apps/ownership-planner/lib/details-offer.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const verify = read("supabase/functions/fni-session-verify/index.ts");
const actions = read("apps/ownership-planner/app/console-actions.ts");
const body = read("apps/ownership-planner/app/details/[sessionId]/DetailsBody.tsx");
const parties = read("apps/ownership-planner/components/ContractParties.tsx");
const fnOf = (src, head) => src.slice(src.indexOf(head), src.indexOf("\n}\n", src.indexOf(head)));

const SHEET_ACTIONS = ["saveVerifyFields", "discardEdits", "refreshFromCrm", "savePartyFields", "removeParty", "restoreParty", "keepStaffValue", "useCrmValue", "saveMenuLevels", "decodeVin"];

test("each action's Edge Function answers with sheetFor() of the session read after its write", () => {
  for (const name of ["save", "discardEdits", "partyAction", "setMenuLevels", "refresh"]) {
    const fn = fnOf(verify, `async function ${name}(`);
    const ok = [...fn.matchAll(/return json\(200, \{?\s*(?:\.\.\.)?\(?await sheetFor\(supabase, (\w+)\)/g)];
    assert.ok(ok.length > 0 || (name === "discardEdits" && /return await refresh\(supabase, fresh, discarded\);/.test(fn)), name);
    for (const m of ok) {
      // That session is read after the write, never the one from before it.
      const read = fn.lastIndexOf(`${m[1]} = (await loadSession(`, m.index);
      assert.ok(read > 0 || fn.lastIndexOf(`const ${m[1]} = changed.length > 0 ? (await loadSession(`, m.index) > 0, `${name}: ${m[1]}`);
    }
  }
});

test("the events each action records after answering are not ones the sheet reads", () => {
  const read = ["PROVIDER_ANSWER_EVENT", "REFRESHED_UNCHANGED_EVENT", "REFRESHED_HELD_EVENT"];
  const sheetReads = [...fnOf(verify, "async function sheetFor(").matchAll(/[A-Z_]+_EVENT/g)].map((m) => m[0]);
  assert.deepEqual(sheetReads, []);
  const recorded = [...verify.matchAll(/credited\([\s\S]*?,\s+([A-Z_]+_EVENT)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(recorded)].sort(), ["EDITS_DISCARDED_EVENT", "MENU_LEVELS_EVENT", "PARTIES_CHANGED_EVENT", "REFRESHED_EVENT", "SHEET_SAVED_EVENT", "VERIFIED_EVENT"]);
  for (const e of recorded) assert.ok(!read.includes(e), e);
  // Nor is any of them a "Rated again by" event, the one the out-of-date list reads.
  const staffEvents = read.concat(recorded).join(" ");
  assert.doesNotMatch(staffEvents, /RATED_AGAIN/);
});

test("the DX1 check runs again only where the action re-pulls what it reads", () => {
  // It reads the session's finance_type, lienholder_name and menu_choice, the
  // CRM record and the contracts (fni-dx1-check). Refresh and Discard re-pull
  // the deal from the CRM; nothing else here writes any of those.
  const dx1 = read("supabase/functions/fni-dx1-check/index.ts");
  assert.match(dx1, /select\("id, zoho_deal_id, dx1_check, finance_type, lienholder_name, menu_choice"\)/);
  for (const name of ["save", "partyAction", "setMenuLevels"]) {
    const fn = fnOf(verify, `async function ${name}(`);
    for (const col of ["finance_type", "lienholder_name", "menu_choice"]) {
      assert.doesNotMatch(fn, new RegExp(`\\.update\\(\\{[^}]*\\b${col}\\b`), `${name}: ${col}`);
    }
  }
  assert.match(fnOf(actions, "export async function refreshFromCrm("), /"refreshed", \{ dx1: true \}\);/);
  assert.match(fnOf(actions, "export async function discardEdits("), /"discarded",\s*\{ dx1: true \}\s*\);/);
  for (const name of SHEET_ACTIONS.filter((n) => !["refreshFromCrm", "discardEdits"].includes(n))) {
    assert.doesNotMatch(fnOf(actions, `export async function ${name}(`), /dx1: true/, name);
  }
  const va = fnOf(actions, "async function verifyAction(");
  assert.match(va, /const dx1 = opts\.dx1 \? await edge\.dx1Check<unknown>\(sessionId\)\.catch\(\(\) => null\) : undefined;/);
  // After the action, as a reload runs it after the action's write.
  assert.ok(va.indexOf("reply = await edge.verifyAction") < va.indexOf("edge.dx1Check"));
});

test("each action answers with the sheet and asks for no redraw, unless it cannot be used", () => {
  for (const name of SHEET_ACTIONS) {
    assert.match(actions, new RegExp(`export async function ${name}\\((?:formData|fd): FormData\\): Promise<SheetAnswer>`), name);
  }
  const va = fnOf(actions, "async function verifyAction(");
  const ok = va.slice(va.indexOf("// The answer is the whole sheet"));
  assert.doesNotMatch(ok, /revalidatePath|backToVerify|cookies\(/);
  assert.match(ok, /return answered\(sessionId, onOk, reply, opts\.dx1 \? \{ dx1 \} : \{\}\);/);
  // A refusal is drawn again with its message, as before.
  assert.match(va, /return drawnAgain\(sessionId, "refused", message\);/);
  // Decode the VIN reads the sheet as a page load does, then answers with it.
  const decode = fnOf(actions, "export async function decodeVin(");
  assert.ok(decode.indexOf("await edge.vinDecode") < decode.indexOf("await edge.verifySheet<unknown>(sessionId, { fresh: true })"));
  assert.match(decode, /return answered\(sessionId, "decoded", sheet\);/);
  assert.doesNotMatch(decode.slice(decode.indexOf("let sheet")), /revalidatePath|backToVerify/);
  // A VIN a reload would decode on its own: drawn again, so it still does.
  const ans = fnOf(actions, "async function answered(");
  assert.match(ans, /shouldAutoDecode\(/);
  assert.match(ans, /return drawnAgain\(sessionId, code\);/);
});

test("every form for them on Details posts through the page's wrapper, and answers itself", () => {
  for (const name of ["refreshFromCrm", "saveVerifyFields", "decodeVin", "discardEdits", "saveMenuLevels"]) {
    assert.doesNotMatch(body, new RegExp(`action=\\{${name}\\}`), name);
    const at = body.indexOf(`action={here(${name})}`);
    assert.ok(at > 0, name);
    const tag = body.slice(body.lastIndexOf("<form", at), body.indexOf(">", at));
    assert.match(tag, /data-working-redraw="none"/, name);
  }
  for (const name of ["keepStaffValue", "useCrmValue", "restoreParty", "savePartyFields", "removeParty"]) {
    assert.doesNotMatch(parties, new RegExp(`action=\\{${name}\\}`), name);
    for (const m of parties.matchAll(new RegExp(`<form action=\\{here\\(${name}\\)\\}[^>]*>`, "g"))) {
      assert.match(m[0], /data-working-redraw="none"/, name);
    }
  }
  assert.equal([...parties.matchAll(/<form action=\{here\(/g)].length, 6);
  // The wrapper: the answer's sheet over the screen, the job ended on it.
  const here = body.slice(body.indexOf("const here = useCallback<Here>("), body.indexOf("[loaded, sheet, rated, router]", body.indexOf("const here = useCallback<Here>(")));
  assert.match(here, /const next = answer\.sheet \? sheetFromReply\(answer\.sheet, sheet\) : null;/);
  assert.match(here, /if \(!next\) \{\s*router\.refresh\(\);\s*return;\s*\}/);
  assert.match(here, /dx1: answer\.dx1 !== undefined \? \(answer\.dx1 as Dx1CheckResult \| null\) : rated\?\.dx1,/);
  assert.match(here, /\} finally \{\s*workingDone\(\);\s*\}/);
  assert.match(body, /<AnswerHereProvider value=\{here\}>/);
  assert.match(body, /<Dx1Check result=\{dx1Shown\} \/>/);
});

// ── The sheet an action answers with, against a reload (made-up sheets) ─────
const screen = {
  session: { id: "s1", deal_number: "99901", status: "Rated" },
  verification: { state: "Verified" },
  rating: { state: "Rated", product_count: 11 },
  day: { today: "2026-11-07", sale_date: "2026-11-07", sale_date_fresh: true, sale_date_problem: null, submit_problem: null },
  fields: [{ key: "warranty", value: "12" }],
  edited: [],
};
const reloaded = { ...screen, fields: [{ key: "warranty", value: "24" }], edited: [{ key: "warranty", in_crm: false }] };

test("the sheet a Save answers with is the sheet a reload shows", () => {
  const reply = { ...reloaded, day: { ...reloaded.day, sale_date_fresh: false }, changed_inputs: ["warranty"] };
  assert.deepEqual(sheetFromReply(reply, screen), reloaded);
  // A Refresh's words beside the sheet are dropped too.
  assert.deepEqual(sheetFromReply({ ...reply, refreshed: true, discarded_edits: ["sale_price"] }, screen), reloaded);
});

test("Rate again and the first rate go over the sheet on the screen, an action's answer included", () => {
  const again = body.slice(body.indexOf("const rateAgainHere = useCallback("), body.indexOf("const verifyAndRateHere"));
  assert.match(again, /sheet: mergeOfferDetails\(sheet, answer\.details!\),/);
  assert.match(again, /dx1: rated\?\.dx1,/);
});
