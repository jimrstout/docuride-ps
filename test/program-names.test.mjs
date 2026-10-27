// TecAssured's program names, shown to staff so twins can be told apart.
// Our one name covers a UTV, an On-Road and an Off-Road MC version; the label
// is what says which. Staff screens only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { programName, programNamesFromQuote } from "../supabase/functions/_shared/program-names.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the program name is the label up to TecAssured's product line", () => {
  assert.equal(programName("USED BRONZE ON-ROAD NON-EU - RIDERS ADVANTAGE PPM"), "USED BRONZE ON-ROAD NON-EU");
  assert.equal(programName("RA THEFT PLAN A"), "RA THEFT PLAN A");
  assert.equal(programName("  "), null);
  assert.equal(programName(null), null);
});

test("a quote gives each product's program name by its code", () => {
  const quote = {
    quote: {
      vehicles: [{
        products: [
          { unique: "62_7", label: "USED BRONZE ON-ROAD NON-EU - RIDERS ADVANTAGE PPM" },
          { unique: "66_7", label: "USED BRONZE UTV (Side by Side) - RIDERS ADVANTAGE PPM" },
          { unique: "24_5", desc: "RA THEFT PLAN A" },
          { unique: "x", label: "" },
        ],
      }],
    },
  };
  const names = programNamesFromQuote(quote);
  assert.equal(names.get("62_7"), "USED BRONZE ON-ROAD NON-EU");
  assert.equal(names.get("66_7"), "USED BRONZE UTV (Side by Side)");
  assert.equal(names.get("24_5"), "RA THEFT PLAN A");
  assert.equal(names.has("x"), false);
  assert.equal(programNamesFromQuote(undefined).size, 0);
});

test("every rating keeps the catalog's program names current", () => {
  const rate = src("../supabase/functions/_shared/rate-session.ts");
  assert.match(rate, /recordProgramNames\(/);
  assert.match(rate, /provider_program_name/);
});

test("staff screens show the label; the planner never does", () => {
  for (const f of [
    "../apps/ownership-planner/app/admin/menus/page.tsx",
    "../apps/ownership-planner/app/admin/providers/wording/page.tsx",
    "../apps/ownership-planner/app/details/[sessionId]/page.tsx",
  ]) assert.match(src(f), /<ProgramLabel /, f);
  assert.match(src("../supabase/functions/fni-admin-settings/templates.ts"), /program: c\.provider_program_name/);
  assert.match(src("../supabase/functions/fni-admin-settings/wording.ts"), /provider_program_name/);
  assert.match(src("../supabase/functions/fni-session-verify/index.ts"), /program_name: programOf\(/);
  // The customer's planner payload never carries it.
  assert.doesNotMatch(src("../supabase/functions/fni-session-get/index.ts"), /program_name|provider_program_name/);
});

test("twins in the pricing scopes are named by program, else by code", () => {
  assert.match(src("../supabase/functions/fni-admin-settings/pricing.ts"), /\$\{p\.program \?\? p\.code\}/);
});
