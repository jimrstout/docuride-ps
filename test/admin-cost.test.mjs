// The cost estimate rr-report returns on mode=preview and mode=approve, as the
// review sheet renders it. Pricing is advisory, so cost:null must draw nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin } from "./_admin-dom.mjs";

const preview = (cost) => ({
  period: "202608",
  filename: "AS0001_202608.csv",
  transactions: 128,
  deals: 41,
  range: { start: "2026-08-01", end: "2026-08-31" },
  stores: ["All Seasons Powersports, Boise"],
  rows: [["2026-08-04", "0122", "All Seasons Powersports", "", "1 Main St", "Boise", "ID", "83702", "D-1001"]],
  cost,
});

test("the minimum applying is spelled out, not just charged", async () => {
  const { w } = await loadAdmin();
  w.drawSheet(preview({
    form_fees: 43.4, minimum: 375, estimated: 375,
    minimum_applies: true, priced_rows: 12, unpriced: [],
  }), "preview");

  const cost = w.document.querySelector("#sheet .cost");
  assert.ok(cost, "cost block missing");
  assert.equal(cost.querySelector(".main").textContent, "Estimated R&R invoice: $375.00");
  assert.equal(cost.querySelector(".sub").textContent,
    "Form fees $43.40 — below the $375.00 monthly minimum, which applies");
  assert.equal(cost.querySelector(".warn"), null);
});

test("form fees above the minimum, with the unpriced rows called out in red", async () => {
  const { w } = await loadAdmin();
  w.drawSheet(preview({
    form_fees: 412.06, minimum: 375, estimated: 412.06,
    minimum_applies: false, priced_rows: 128,
    unpriced: [{ form_id: "9901", count: 3 }, { form_id: "IDAHO-2", count: 1 }],
  }), "preview");

  const cost = w.document.querySelector("#sheet .cost");
  assert.equal(cost.querySelector(".main").textContent, "Estimated R&R invoice: $412.06");
  assert.equal(cost.querySelector(".sub").textContent,
    "Form fees $412.06 across 128 forms (above the $375.00 monthly minimum)");
  assert.equal(cost.querySelector(".warn").textContent,
    "4 form rows have no price on file and are excluded: 9901, IDAHO-2");
});

test("no cost object draws no cost block, and the approve re-render keeps it", async () => {
  const { w } = await loadAdmin();
  w.drawSheet(preview(null), "preview");
  assert.equal(w.document.querySelector("#sheet .cost"), null);

  // mode=approve carries its own cost; the approved re-render must show it.
  w.drawSheet(preview({
    form_fees: 500, minimum: 375, estimated: 500,
    minimum_applies: false, priced_rows: 130, unpriced: [],
  }), "approved");
  assert.equal(w.document.querySelector("#sheet .stamp-mark").textContent, "approved");
  assert.equal(w.document.querySelector("#sheet .cost .main").textContent, "Estimated R&R invoice: $500.00");
});

test("pennies are never rounded away", async () => {
  const { w } = await loadAdmin();
  w.drawSheet(preview({
    form_fees: 1234.5, minimum: 375, estimated: 1234.5,
    minimum_applies: false, priced_rows: 300, unpriced: [],
  }), "preview");
  assert.equal(w.document.querySelector("#sheet .cost .main").textContent,
    "Estimated R&R invoice: $1,234.50");
});
