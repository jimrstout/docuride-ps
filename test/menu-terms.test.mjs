// Payment terms on the conventional menu (docs section 26, migration 0046):
// the deal's own term first, up to two more with their own rates, plain
// words, and the note when the customer chooses another. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as shared from "../supabase/functions/_shared/menu-terms.ts";
import * as app from "../apps/ownership-planner/lib/menu-terms.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const DEAL = { months: 60, rate: 5.9 };

test("the browser and the server say the same", () => {
  const body = (f) => read(f).slice(read(f).indexOf("export const MAX_EXTRA_TERMS"));
  assert.equal(body("apps/ownership-planner/lib/menu-terms.ts"), body("supabase/functions/_shared/menu-terms.ts"));
  assert.equal(app.paymentText(654.32, { months: 60, rate: 5.9, deal_term: true }), shared.paymentText(654.32, { months: 60, rate: 5.9, deal_term: true }));
});

test("plain words: rates, terms and payments", () => {
  assert.equal(shared.rateText(5.9), "5.90%");
  assert.equal(shared.rateText(7.74), "7.74%");
  assert.equal(shared.rateText(6.999), "6.999%");
  assert.equal(shared.termText({ months: 72, rate: 7.74, deal_term: false }), "72 months at 7.74%");
  assert.equal(shared.termText({ months: 60, rate: 5.9, deal_term: true }), "60 months at 5.90%, the deal's term");
  assert.equal(shared.paymentText(654.32, { months: 60, rate: 5.9, deal_term: true }), "$654.32 a month for 60 months at 5.90%");
  assert.equal(shared.paymentText(1234.5, { months: 72, rate: 7.74, deal_term: false }), "$1,234.50 a month for 72 months at 7.74%");
});

test("the deal's term is always first; at most two more; a repeat of the deal's is left out; cash has none", () => {
  assert.deepEqual(shared.columnTerms(DEAL, [{ months: 72, rate: 7.74 }, { months: 60, rate: 5.9 }, { months: 84, rate: 8.1 }, { months: 96, rate: 9 }]), [
    { months: 60, rate: 5.9, deal_term: true },
    { months: 72, rate: 7.74, deal_term: false },
    { months: 84, rate: 8.1, deal_term: false },
  ]);
  assert.deepEqual(shared.columnTerms(DEAL, null), [{ months: 60, rate: 5.9, deal_term: true }]);
  assert.deepEqual(shared.columnTerms(null, [{ months: 72, rate: 7.74 }]), []);
  assert.deepEqual(shared.columnTerms({ months: null, rate: 5.9 }, []), []);
});

test("an extra term always has its own rate", () => {
  assert.deepEqual(shared.parseTerms([{ months: "72", rate: "7.74" }, { months: "", rate: "" }], "Gold"), { terms: [{ months: 72, rate: 7.74 }] });
  assert.deepEqual(shared.parseTerms([{ months: "72", rate: "" }], "Gold").errors, ["Gold: an extra term needs both its months and its interest rate."]);
  assert.deepEqual(shared.parseTerms([{ months: "3", rate: "5" }], "Gold").errors, ["Gold: 3 is not a term in months."]);
  assert.deepEqual(shared.parseTerms([{ months: "72", rate: "seven" }], "Gold").errors, ["Gold: seven is not an interest rate."]);
  assert.deepEqual(shared.parseTerms([{ months: "72", rate: "7.74%" }], "Gold"), { terms: [{ months: 72, rate: 7.74 }] });
  assert.deepEqual(shared.parseTerms([{ months: "72", rate: "1" }, { months: "84", rate: "2" }, { months: "96", rate: "3" }], "Gold").errors,
    ["Gold: at most two extra terms, three with the deal's own."]);
});

test("the package event and the Details note, in the words asked for", () => {
  assert.equal(shared.packageChosenEvent("Gold", { months: 72, rate: 7.74, deal_term: false }, ["Tire and Wheel", "Battery"]),
    "Package chosen: Gold, 72 months at 7.74%. Removed: Tire and Wheel, Battery.");
  assert.equal(shared.packageChosenEvent("Silver", { months: 60, rate: 5.9, deal_term: true }, []), "Package chosen: Silver, 60 months at 5.90%.");
  assert.equal(shared.packageChosenEvent("Basic", null, ["Theft"]), "Package chosen: Basic. Removed: Theft.");
  assert.equal(shared.chosenTermNote({ months: 72, rate: 7.74, deal_term: false }, DEAL),
    "The customer chose 72 months at 7.74%. The finance terms in the CRM say 60 months at 5.90%. Update the deal in DX1 and the CRM before generating documents.");
  assert.equal(shared.chosenTermNote({ months: 60, rate: 5.9, deal_term: true }, DEAL), null);
  for (const f of ["supabase/functions/_shared/menu-terms.ts", "apps/ownership-planner/lib/menu-terms.ts"]) assert.doesNotMatch(read(f), /—/);
});

test("presets: Financed only, managers only, every change logged", () => {
  const t = read("supabase/functions/fni-admin-settings/templates.ts");
  const save = t.slice(t.indexOf('case "save_presets": {'), t.indexOf("default:", t.indexOf('case "save_presets": {')));
  assert.match(save, /if \(dealType === "Financed"\) \{/);
  assert.match(save, /record_key: `terms\|\$\{templateId\}\|\$\{w\.column_position\}\|\$\{w\.slot\}`/);
  assert.ok(save.indexOf("await logChanges(") < save.indexOf('.from("menu_preset_terms").upsert('));
  assert.doesNotMatch(t, /\.delete\(/);
  const page = read("apps/ownership-planner/app/admin/menus/page.tsx");
  assert.match(page, /\{dealType === "Financed" \? termsLine\(ci \+ 1\) : "A total, no payments"\}/);
  assert.match(page, /name=\{`t_\$\{ci \+ 1\}_\$\{slot\}_months`\}/);
  assert.match(page, /name=\{`t_\$\{ci \+ 1\}_\$\{slot\}_rate`\}/);
});

test("the menu: a payment line per term, the term chosen with the package, checked by the save", () => {
  const menu = read("apps/ownership-planner/app/menu/[sessionId]/Menu.tsx");
  assert.match(menu, /<span>\{paymentText\(p\.totals\.totalPayment, p\.t\)\}<\/span>/);
  assert.match(menu, /onClick=\{\(\) => void record\(cells\[ci\], c\.name, ci \+ 1, f\.term\)\}/);
  assert.match(menu, /term: chosenTerm \? \{ months: chosenTerm\.months, rate: chosenTerm\.rate \} : null,/);
  const save = read("supabase/functions/fni-session-save/index.ts");
  assert.match(save, /const term = asked === null\s*\? terms\[0\] \?\? null\s*: terms\.find\(/);
  assert.match(save, /patch\.menu_choice = \{ column: chosen\.column, name: menuEvent!\.package, term: chosen\.term, kept, removed: chosen\.removed \};/);
  // PS never writes the CRM's finance terms.
  assert.doesNotMatch(save, /updateRecord|Finance_Term|Interest_Rate/);
});

test("Details: the note when the customer chose a term other than the deal's", () => {
  const verify = read("supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /chosen_term_note: chosenTermNote\(/);
  assert.match(verify, /"menu_choice",/);
  const page = read("apps/ownership-planner/app/details/[sessionId]/page.tsx");
  assert.match(page, /\{sheet\.chosen_term_note \? \(\s*<p className="console-flash console-flash--bad" role="alert">\{sheet\.chosen_term_note\}<\/p>/);
});
