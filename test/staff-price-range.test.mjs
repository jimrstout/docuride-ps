// The staff price range as a manager setting (docs section 29): Administration
// > Pricing. Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BAND_NOTICE, parseRuleFields, unreviewedBands } from "../supabase/functions/_shared/pricing-admin.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const page = read("apps/ownership-planner/app/admin/pricing/page.tsx");
const handler = read("supabase/functions/fni-admin-settings/pricing.ts");

test("the band settings are labelled plainly, with one line of help", () => {
  for (const label of ["Staff minimum markup ($ over dealer cost)", "Staff maximum markup (% over dealer cost)", "Staff maximum markup ($ over dealer cost)"]) {
    assert.ok(page.includes(`<span>${label}</span>`), label);
  }
  assert.ok(page.includes("Staff can price between these. Outside them needs a manager."));
  // Managers only; every change logged with who and when.
  assert.match(handler, /if \(!\(await isManager\(supabase, body\.operator_id\)\)\) return \{ status: 403, body: \{ error: MANAGERS_ONLY \} \};/);
  assert.match(handler, /area: "Price band",/);
});

test("the staff maximum cannot sit below the staff minimum", () => {
  const base = { cost_floor: "0", cost_ceiling: "400", markup_percent: "250" };
  assert.deepEqual(parseRuleFields({ ...base, markup_min_dollars: "75", max_markup_dollars: "50" }).errors,
    ["Staff maximum markup cannot be less than the staff minimum markup."]);
  assert.ok("fields" in parseRuleFields({ ...base, markup_min_dollars: "75", max_markup_dollars: "75" }));
  assert.ok("fields" in parseRuleFields({ ...base, markup_min_dollars: "75", max_markup_percent: "40" }));
});

test("the setup-values notice shows until a manager saves each band, then clears", () => {
  assert.equal(BAND_NOTICE, "These pricing bands still have their setup values. Review and save them.");
  const bands = [
    { id: "a", band_reviewed_at: null }, { id: "b", band_reviewed_at: null },
  ];
  assert.equal(unreviewedBands(bands), 2);
  // A manager saves one: still shown for the other.
  bands[0].band_reviewed_at = "2026-11-01T12:00:00Z";
  assert.equal(unreviewedBands(bands), 1);
  bands[1].band_reviewed_at = "2026-11-01T12:05:00Z";
  assert.equal(unreviewedBands(bands), 0);
  // Saving stamps the review; a copy keeps whether its source was reviewed.
  assert.match(handler, /band_reviewed_at: now, band_reviewed_by: updatedBy/);
  assert.match(handler, /band_reviewed_at: r\.band_reviewed_at \?\? null,/);
  assert.match(handler, /band_notice: unreviewedBands\(own\) > 0 \? BAND_NOTICE : null,/);
  assert.match(page, /\{payload\.band_notice \? \(/);
  // The values themselves are never changed for this.
  assert.doesNotMatch(read("supabase/migrations/0047_staff_price_range.sql"), /update fni\.pricing_rules/i);
});
