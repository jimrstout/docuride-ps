// Verify's staff contracts panel: Submit what the customer chose, Get each
// document into the Deal Jacket, Void with a reason and a confirm step, and the
// voided file renamed, never deleted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { savedSelections } from "../supabase/functions/_shared/saved-selections.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the customer's saved choices become the selections the quote is matched on", () => {
  assert.deepEqual(
    savedSelections([
      { provider_product_id: "16_3", rate_unique_id: "1898-5", selected_options: ["opt-1"], customer_price: "1499.00", retail_price: null },
      { provider_product_id: "23_4", rate_unique_id: "175731", selected_options: null, customer_price: null, retail_price: 399.5 },
      { provider_product_id: "", rate_unique_id: "x", selected_options: [], customer_price: 1, retail_price: 1 },
    ]),
    [
      { product_unique: "16_3", rate_unique: "1898-5", option_uniques: ["opt-1"], retail_price: 1499 },
      { product_unique: "23_4", rate_unique: "175731", option_uniques: [], retail_price: 399.5 },
    ]
  );
  const submit = src("../supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /if \(body\.use_saved_selections === true\) \{/);
  assert.match(submit, /\.eq\("disposition", "Included"\)/);
  // The saved choices go through the same OEM split, lock and QA rule as any submit.
  assert.ok(submit.indexOf("use_saved_selections === true") < submit.indexOf("splitSelections(body.selections"));
});

test("void needs a reason, keeps it, and renames the Deal Jacket file with VOID", () => {
  const fn = src("../supabase/functions/fni-contract-void/index.ts");
  assert.match(fn, /Say why this contract is being voided\. The reason is kept with the contract\./);
  assert.ok(fn.indexOf("Say why this contract is being voided") < fn.indexOf("client.voidContract("));
  assert.match(fn, /void_reason: reason,/);
  assert.match(fn, /await renameFile\(row\.workdrive_file_id, name\);/);
  assert.ok(fn.indexOf("client.voidContract(") < fn.lastIndexOf("markFileVoid(supabase, row)"));
  assert.doesNotMatch(fn, /trashFile|method: "DELETE"/);
});

test("the panel shows once the planner is finished, and every button says what it is doing", () => {
  const verify = src("../supabase/functions/fni-session-verify/index.ts");
  assert.match(verify, /const PLANNER_DONE = \["Products Selected", "Agreement Created", "Finalized"\];/);
  assert.match(verify, /contracts_panel: panel,/);
  const page = src("../apps/ownership-planner/app/details/[sessionId]/page.tsx");
  // No provider name on the button, and a confirmation first (2026-10-28).
  const modal = src("../apps/ownership-planner/components/SubmitConfirm.tsx");
  assert.match(page, /<SubmitConfirm\s/);
  assert.match(modal, />\s*Submit contracts\s*</);
  assert.doesNotMatch(page + modal, /Submit contracts to/);
  assert.match(modal, /pending="Submitting contracts\.\.\."/);
  assert.match(page, /pending="Getting the document\.\.\."/);
  assert.match(page, /pending="Voiding\.\.\."/);
  assert.match(page, /name="confirm" required \/> Cancel this contract with \{vendor\}/);
  assert.match(page, /sheet\.submit_state === "In Progress" \?/);
  assert.doesNotMatch(page, /—/);
  const button = src("../apps/ownership-planner/components/PendingButton.tsx");
  // Disabled while its own send is with the server (components/Working.tsx).
  assert.match(button, /disabled=\{disabled \|\| busy\}/);
  assert.match(button, /: status\.pending;/);
  const actions = src("../apps/ownership-planner/app/console-actions.ts");
  assert.match(actions, /use_saved_selections: true,/);
  assert.match(actions, /if \(formData\.get\("confirm"\) !== "on"\)/);
});
