// Which presentation recorded the customer's choices, the menu's session
// events, who presented, and the Details buttons (2026-10-30). Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MENU_DECLINED_EVENT,
  MENU_OPENED_EVENT,
  menuEventName,
  parseMenuEvent,
  pathForSave,
  presenterName,
  signedBy,
} from "../supabase/functions/_shared/presentation.ts";
import { modeLabel } from "../supabase/functions/_shared/session-mode.ts";
import { initialsFor, nameFromEmail } from "../apps/ownership-planner/lib/admin-sections.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const PAGE = "apps/ownership-planner/app/details/[sessionId]/page.tsx";

test("the path is recorded as people read it; a save that names none is the planner's", () => {
  assert.equal(pathForSave("Conventional Menu"), "Conventional Menu");
  assert.equal(pathForSave(undefined), "Ownership Planner");
  assert.equal(pathForSave("Something else"), "Ownership Planner");
  const save = read("supabase/functions/fni-session-save/index.ts");
  assert.match(save, /if \(decisions\.length > 0\) patch\.presentation_path = pathForSave\(body\.presentation_path\);/);
  const menu = read("apps/ownership-planner/app/menu/[sessionId]/Menu.tsx");
  assert.match(menu, /presentation_path: "Conventional Menu",\s*mode: "Staff-Presented",/);
  // The planner sends no path: unchanged.
  assert.doesNotMatch(read("apps/ownership-planner/app/plan/[sessionId]/Planner.tsx"), /presentation_path/);
});

test("the menu's events, signed with initials or System", () => {
  assert.equal(menuEventName(parseMenuEvent({ kind: "opened" })), "Conventional menu opened");
  assert.equal(menuEventName(parseMenuEvent({ kind: "selected", package: " Gold " })), "Package selected on the conventional menu: Gold");
  assert.equal(menuEventName(parseMenuEvent({ kind: "declined" })), MENU_DECLINED_EVENT);
  assert.equal(parseMenuEvent({ kind: "selected", package: "" }), null);
  // The column, the term and the products removed ride along.
  assert.deepEqual(parseMenuEvent({ kind: "selected", package: "Gold", column: 2, term: { months: 72, rate: 7.74 }, removed: ["Battery"] }),
    { kind: "selected", package: "Gold", column: 2, term: { months: 72, rate: 7.74 }, removed: ["Battery"] });
  assert.equal(parseMenuEvent("opened"), null);
  assert.equal(signedBy("js"), "JS");
  assert.equal(signedBy(undefined), "System");
  assert.equal(signedBy("Jim Stout"), "System");
  for (const e of [MENU_OPENED_EVENT, MENU_DECLINED_EVENT]) assert.doesNotMatch(e, /—/);

  const save = read("supabase/functions/fni-session-save/index.ts");
  // Opening records the event and changes nothing else.
  assert.match(save, /if \(menuEvent\?\.kind === "opened"\) \{\s*await recordEvent\(menuEventName\(menuEvent\)\);\s*return json\(200,/);
  assert.match(save, /created_by: signedBy\(body\.presented_by\)/);
  // A package chosen reads as the package, its term and what was removed
  // (_shared/menu-terms.ts packageChosenEvent, docs section 26).
  assert.match(save, /if \(menuEvent && body\.complete === true\) await recordEvent\(chosenEvent \?\? menuEventName\(menuEvent\)\);/);
  assert.match(save, /chosenEvent = packageChosenEvent\(menuEvent\.package!, term, removed\);/);
  const page = read("apps/ownership-planner/app/menu/[sessionId]/page.tsx");
  assert.match(page, /menu_event: \{ kind: "opened" \}, \.\.\.\(await presenter\(\)\)/);
});

test("who presented comes from this browser's console cookie, never from the browser's body", () => {
  const route = read("apps/ownership-planner/app/api/session/[id]/save/route.ts");
  assert.match(route, /const \{ presented_by: _by, presented_by_name: _name, \.\.\.rest \} = body;/);
  assert.match(route, /edge\.sessionSave\(\{ \.\.\.rest, \.\.\.\(await presenter\(\)\), session_id: check\.id \}\)/);
  assert.equal(nameFromEmail("sample.person@example.com"), "Sample Person");
  assert.equal(nameFromEmail("sample_person+fni@example.com"), "Sample Person Fni");
  assert.equal(initialsFor("sample.person@example.com"), "SP");
  assert.equal(presenterName("  Sample   Person "), "Sample Person");
  assert.equal(presenterName(""), null);
});

test("the acknowledgment names the staff member who presented, on both paths", () => {
  assert.equal(modeLabel("Staff-Presented", "Sample Person"), "Presented by Sample Person, dealership staff");
  assert.equal(modeLabel("Self-Guided", "Sample Person"), "Presented by Sample Person, dealership staff");
  assert.equal(modeLabel("Staff-Presented", null), "Presented by dealership staff");
  assert.equal(modeLabel("Self-Guided"), "Self-guided");
  assert.match(read("supabase/functions/_shared/acknowledgment-pdf.ts"), /modeLabel\(input\.mode, input\.presented_by_name\)/);
  assert.match(read("supabase/functions/fni-session-get/index.ts"), /modeLabel\(s\.mode as string \| null, s\.presented_by_name as string \| null\)/);
  assert.match(read("supabase/functions/fni-session-save/index.ts"), /if \(body\.complete === true && presenter\) patch\.presented_by_name = presenter;/);
});

test("both buttons: verified, rated and current; a live contract does not block them", () => {
  const page = read(PAGE);
  assert.match(page, /const presentable = verified && sheet\.rating\.state === "Rated" && !sheet\.rating\.out_of_date;/);
  assert.match(page, /href=\{`\/plan\/\$\{sessionId\}`\}\s*target="_blank"\s*rel="noopener"/);
  assert.match(page, /href=\{`\/menu\/\$\{sessionId\}`\}\s*target="_blank"\s*rel="noopener"\s*>\s*Present menu\s*</);
  assert.doesNotMatch(page.slice(page.indexOf("const presentable =")).split("\n")[0], /contract/);
});

test("a manager sets each column's coverage level for this deal on Details", () => {
  const page = read(PAGE);
  assert.match(page, /\{presentable && operator && \(sheet\.menu_columns\?\.length \?\? 0\) > 0 \? \(\s*<form action=\{saveMenuLevels\}/);
  assert.match(page, /<select name=\{`level_\$\{c\.position\}`\} defaultValue=\{c\.level\}>/);
  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /if \(action === "menu_levels"\) return await setMenuLevels\(supabase, s, body\.levels\);/);
  // Only levels that differ from the template's are kept.
  assert.match(verify, /if \(v !== c\.template_level\) levels\[String\(c\.position\)\] = v;/);
  // The menu reads them.
  assert.match(read("supabase/functions/fni-session-get/index.ts"), /return isLevel\(level\) \? \{ \.\.\.c, starting_level: level \} : c;/);
});
