// Details after Verify and the first rate: updated from the two answers,
// never drawn again, and the same as a full reload (7 Nov 2026, after deal
// 07982 sat on "Rating... Still working" for a minute after its rating was
// stored, as Rate again did before #148).
//
// The proof, as for Rate again (test/details-offer.test.mjs):
//   1. Verify answers with the whole sheet, built by sheetFor(), the function
//      Details loads with, from the session as verification left it.
//   2. The rating answers with what it changed, built by offerParts(), the
//      function Details loads those parts with, from the session as it stands
//      once everything the rating writes is written.
//   3. Nothing else on the sheet reads what a rating writes.
//   4. The rating's answer put over Verify's sheet is exactly the sheet a
//      reload gives (mock data).
// scripts/rate-again-check.mjs adds a fifth in a real browser, with a
// 15 second rating. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeOfferDetails, OFFER_KEYS, REPLY_ONLY_KEYS, sheetFromReply } from "../apps/ownership-planner/lib/details-offer.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const rate = read("supabase/functions/fni-rate-vehicle/index.ts");
const verify = read("supabase/functions/fni-session-verify/index.ts");
const between = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

test("1. Verify answers with sheetFor() of the session as verification left it", () => {
  const fn = between(verify, "async function verify(", "\n}\n");
  assert.match(fn, /const fresh = \(await loadSession\(supabase, s\.id as string\)\)!;\s*return json\(200, \{\s*\.\.\.\(await sheetFor\(supabase, fresh\)\),\s*\/\/[^\n]*\n[^\n]*\n[^\n]*\n\s*verified: true,\s*\}\);/);
  // The event credited after it names who verified, and is not one the sheet reads.
  assert.match(verify, /if \(action === "verify"\) \{[\s\S]*?return await credited\(await verify\(supabase, s, who\), VERIFIED_EVENT\);/);
});

test("2. every first-rate answer carries offerParts() of the session as it now stands", () => {
  const helper = between(rate, "async function withDetails(", "\n}\n");
  assert.match(helper, /const \{ data: fresh \} = await supabase\.schema\("fni"\)\.from\("sessions"\)\.select\("\*"\)\.eq\("id", sessionId\)\.maybeSingle\(\);/);
  assert.match(helper, /await offerParts\(supabase, fresh as Record<string, unknown>\)/);
  const first = between(rate, "// ── Step 3: Rate every provider the menu needs", "} catch (err) {");
  // After the session's status, template and providers are written.
  const written = first.indexOf("if (statusErr) console.error(");
  assert.ok(written > 0);
  for (const reply of ["withDetails(supabase, session_id, 200, {\n        session_id,\n        status: sess.status,", "withDetails(supabase, session_id, 400, {", "withDetails(supabase, session_id, 200, {\n      session_id,\n      status: nextStatus,"]) {
    const at = first.indexOf(reply);
    assert.ok(at > written, reply.split("\n")[0]);
  }
  // No first-rate answer after the rating goes out without it.
  assert.doesNotMatch(first.slice(written), /return json\(/);
  // A failure that throws answers with the failed rating too, once it is recorded.
  const caught = between(rate, '    console.error("fni-rate-vehicle error:", message);', "\n});");
  assert.ok(caught.indexOf("await recordOutcome(") < caught.indexOf("withDetails(supabase, session_id, 500"));
});

test("3. nothing else on the sheet reads what a rating writes", () => {
  // A rating writes the offers, the session's status, template, providers and
  // TecAssured login, the provider's makes, its form codes and the catalog's
  // program names. Only offerParts() reads any of them.
  const sheet = between(verify, "async function sheetFor(", "\n}\n");
  const rest = sheet.replace(/const offerRead = offerParts\(supabase, s\);/, "");
  for (const written of ["rated_offers", "rated_provider_ids", "menu_template_id", "credential_id", "dealer_code_used", "provider_makes", "form_codes", "provider_program_name", "s.status"]) {
    assert.doesNotMatch(rest, new RegExp(written.replace(".", "\\.")), written);
  }
  // The session's status on the sheet is the rating's.
  assert.match(sheet, /status: offer\.session_status,/);
  const verification = read("supabase/functions/_shared/verification.ts");
  for (const written of ["rated_offers", "rated_provider_ids", "menu_template_id", "credential_id", "dealer_code_used", "provider_makes"]) {
    assert.doesNotMatch(verification, new RegExp(written), written);
  }
});

// ── 4. The merge, with made-up sheets ────────────────────────────────────────
const screen = {
  session: { id: "s1", deal_number: "99901", stock_number: "ST-1", status: "Open", is_test: true, vehicle: "2026 Mockmake Trail", deal_type: "Finance", vehicle_type_code: "UTV" },
  provider_name: "Mock Provider",
  verification: { state: "Needs Verification", verified_at: null, verified_by: null },
  rating: { state: "Pending", product_count: 0, out_of_date: false, rated_at: null, detail: null, providers: [] },
  rating_differences: null,
  menu_columns: [{ position: 1, name: "Gold", template_level: "Middle", level: "Middle" }],
  prepared: null,
  menu_template: { name: "UTV menu" },
  unplaced_offers: [],
  rating_notices: [],
  hidden_slots: [],
  oem_contracts: [],
  contracts_panel: null,
  contracts: [],
  day: { time_zone: "America/New_York", today: "2026-11-07", sale_date: "2026-11-07", sale_date_fresh: true, sale_date_problem: null, submit_problem: null, date_line: null, contract_date_lines: [] },
  fields: [{ key: "vin", value: "SAMPLEVIN" }],
  ready: true,
  submit_state: "Idle",
};
// What a reload shows once verified and rated.
const reloaded = {
  ...screen,
  session: { ...screen.session, status: "Rated" },
  verification: { state: "Verified", verified_at: "2026-11-07T00:45:48Z", verified_by: "JS" },
  rating: { state: "Rated", product_count: 14, out_of_date: false, rated_at: "2026-11-07T00:45:54Z", detail: null, providers: [{ name: "Mock Provider", state: "Rated", line: "Mock Provider: Rated, 14 products." }] },
  menu_columns: [{ position: 1, name: "Gold", template_level: "Middle", level: "Middle" }],
  rating_notices: ["Sample notice."],
};
// Verify's answer: verified, not yet rated, with the words beside the sheet,
// and no CRM read of its own.
const verifiedReply = {
  ...screen,
  session: { ...screen.session, status: "Verified" },
  verification: reloaded.verification,
  day: { ...screen.day, sale_date_fresh: false, sale_date_problem: null },
  verified: true,
};
const ratingAnswer = { session_status: reloaded.session.status, ...Object.fromEntries(OFFER_KEYS.map((k) => [k, reloaded[k]])) };

test("4. the rating's answer put over Verify's sheet is exactly the reloaded sheet", () => {
  const verifiedSheet = sheetFromReply(verifiedReply, screen);
  assert.ok(verifiedSheet);
  assert.deepEqual(mergeOfferDetails(verifiedSheet, ratingAnswer), reloaded);
  // The screen's sheet is not changed in place.
  assert.equal(screen.verification.state, "Needs Verification");
  assert.equal(verifiedReply.day.sale_date_fresh, false);
});

test("4. a reply that is not this deal's sheet is not used: the page is drawn again", () => {
  assert.equal(sheetFromReply(null, screen), null);
  assert.equal(sheetFromReply({ ok: true }, screen), null);
  assert.equal(sheetFromReply({ ...verifiedReply, session: { ...verifiedReply.session, id: "s2" } }, screen), null);
  const { fields: _gone, ...noFields } = verifiedReply;
  assert.equal(sheetFromReply(noFields, screen), null);
  // Every word an action's reply adds beside the sheet is dropped.
  for (const key of REPLY_ONLY_KEYS) assert.equal(key in sheetFromReply({ ...verifiedReply, [key]: 1 }, screen), false, key);
  assert.deepEqual([...REPLY_ONLY_KEYS].sort(), ["changed_inputs", "discarded_edits", "refreshed", "verified"]);
  // And those are all the words any action's reply adds (fni-session-verify).
  const added = [...verify.matchAll(/\.\.\.\(await sheetFor\(supabase, \w+\)\),\s*([\s\S]*?)\}\);/g)]
    .flatMap((m) => [...m[1].matchAll(/^\s*([a-z_]+):/gm)].map((x) => x[1]));
  assert.deepEqual([...new Set(added)].sort(), [...REPLY_ONLY_KEYS].sort());
});

test("Verify and rate on Details: no page drawn again, the job ends on the answers", () => {
  const body = read("apps/ownership-planner/app/details/[sessionId]/DetailsBody.tsx");
  assert.match(body, /<form action=\{verifyAndRateHere\} className="vgate" data-working-redraw="none">/);
  const here = between(body, "const verifyAndRateHere = useCallback(", "[loaded, router]");
  assert.match(here, /const verifiedSheet = answer\.verified \? sheetFromReply\(answer\.verified, sheet\) : null;/);
  assert.match(here, /if \(!verifiedSheet \|\| !answer\.details\) \{\s*router\.refresh\(\);\s*return;\s*\}/);
  assert.match(here, /sheet: mergeOfferDetails\(verifiedSheet, answer\.details!\),/);
  assert.match(here, /\} finally \{\s*workingDone\(\);\s*\}/);
  const action = read("apps/ownership-planner/app/console-actions.ts");
  const fn = between(action, "export async function verifyAndRate(", "\n}\n");
  // Nothing that makes Next draw the page again once Verify is through,
  // unless the answers cannot be used.
  const used = fn.slice(fn.indexOf("// Now the rating."), fn.indexOf("if (details) return { code, detail, verified, details };"));
  assert.doesNotMatch(used, /revalidatePath|backToVerify|cookies\(/);
});
