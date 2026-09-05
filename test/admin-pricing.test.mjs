// The R&R Pricing panel: lazy load, the price table and its filter, click-to-edit
// fees, adding and deleting a price, and the monthly minimum.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAdmin, flush, plain, EMAIL } from "./_admin-dom.mjs";

async function openPricing(){
  const ctx = await loadAdmin();
  const box = ctx.w.document.getElementById("priceBox");
  box.open = true;
  box.dispatchEvent(new ctx.w.Event("toggle"));
  await flush();
  return ctx;
}

test("pricing panel fetches nothing until it is opened", async () => {
  const { calls } = await loadAdmin();
  assert.equal(calls.filter(c => c.table === "rr_form_prices").length, 0);
});

test("pricing panel loads the minimum and the price table on first open", async () => {
  const { w, calls } = await openPricing();

  assert.equal(w.document.getElementById("minFee").value, "375.00");

  const prices = calls.find(c => c.table === "rr_form_prices");
  assert.deepEqual(plain(prices.order), [["section", { ascending: true }], ["form_id", { ascending: true }]]);

  const rows = [...w.document.querySelectorAll("#priceList tbody tr")];
  assert.equal(rows.length, 3);
  assert.deepEqual([...rows[0].children].slice(0, 4).map(td => td.textContent),
    ["0122", "Retail Installment Contract", "$3.22", "A"]);
  assert.equal(rows[2].children[4].textContent, "—");   // never-updated row
});

test("filter matches form_id or description, case-insensitively", async () => {
  const { w } = await openPricing();
  const box = w.document.getElementById("priceFilter");
  const type = (v) => { box.value = v; box.dispatchEvent(new w.Event("input")); };
  const ids = () => [...w.document.querySelectorAll("#priceList tbody tr")].map(tr => tr.children[0].textContent);

  type("ida");
  assert.deepEqual(ids(), ["IDA-1"]);        // matches form_id and description
  type("ODOMETER");
  assert.deepEqual(ids(), ["8721"]);         // description only, case-insensitive
  type("87");
  assert.deepEqual(ids(), ["8721"]);         // form_id only
  type("");
  assert.equal(ids().length, 3);
});

// Fee editing is explicit: the editor is an input plus Save and Cancel, and
// nothing writes until Save is pressed.
const openEditor = (w, i = 0) => {
  const fee = [...w.document.querySelectorAll("#priceList tbody tr")][i].querySelector("td.fee");
  fee.click();
  const box = fee.querySelector(".feeedit");
  const [save, cancel] = box.querySelectorAll("button");
  return { fee, input: box.querySelector("input"), save, cancel };
};
const updates = (calls) => calls.filter(c => c.table === "rr_form_prices" && c.ops.includes("update"));
const feeText = (w, i = 0) =>
  [...w.document.querySelectorAll("#priceList tbody tr")][i].querySelector("td.fee").textContent;

test("clicking a fee opens an editor with Save and Cancel, and writes nothing yet", async () => {
  const { w, calls } = await openPricing();
  assert.equal(feeText(w, 1), "$0.41");

  const { fee, input, save, cancel } = openEditor(w, 1);
  assert.equal(input.value, "0.41");
  assert.equal(save.textContent, "Save");
  assert.equal(cancel.textContent, "Cancel");
  assert.ok(fee.classList.contains("editing"));
  assert.equal(updates(calls).length, 0);
});

test("losing focus never saves, and leaves the row in edit state", async () => {
  const { w, calls } = await openPricing();
  const { fee, input } = openEditor(w, 1);

  input.value = "9.99";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  input.dispatchEvent(new w.FocusEvent("blur", { bubbles: false }));
  input.blur();
  await flush();

  assert.equal(updates(calls).length, 0, "blur wrote a fee");
  assert.ok(fee.querySelector(".feeedit input"), "blur closed the editor");
  assert.equal(fee.querySelector(".feeedit input").value, "9.99", "blur discarded the typed value");
});

test("Save fires exactly one update and re-renders the row", async () => {
  const { w, calls } = await openPricing();
  const { input, save } = openEditor(w, 1);

  input.value = "1.25";
  save.click();
  await flush();

  const write = updates(calls);
  assert.equal(write.length, 1);
  assert.deepEqual(plain(write[0].patch), { transaction_fee: 1.25, updated_by: EMAIL });
  assert.deepEqual(plain(write[0].eq), { form_id: "8721" });

  assert.equal(feeText(w, 1), "$1.25");
  // updated_at is stamped by the trigger; the row shows today until the next load.
  const updated = [...w.document.querySelectorAll("#priceList tbody tr")][1].children[4];
  assert.equal(updated.textContent, new Date().toLocaleDateString("en-US"));
  assert.equal(updated.title, EMAIL);
});

test("Enter is a shortcut for Save", async () => {
  const { w, calls } = await openPricing();
  const { input } = openEditor(w, 1);
  input.value = "2.00";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();

  assert.equal(updates(calls).length, 1);
  assert.equal(feeText(w, 1), "$2.00");
});

test("Cancel restores the original fee and writes nothing", async () => {
  const { w, calls } = await openPricing();
  const { input, cancel } = openEditor(w, 0);
  input.value = "99.99";
  cancel.click();
  await flush();

  assert.equal(updates(calls).length, 0);
  assert.equal(feeText(w, 0), "$3.22");
});

test("Escape cancels the edit", async () => {
  const { w, calls } = await openPricing();
  const { input } = openEditor(w, 0);
  input.value = "99.99";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flush();

  assert.equal(updates(calls).length, 0);
  assert.equal(feeText(w, 0), "$3.22");
});

test("a fee with three decimals errors inline and stays in edit state", async () => {
  const { w, calls } = await openPricing();
  const { fee, input, save } = openEditor(w, 0);
  input.value = "3.225";
  save.click();
  await flush();

  assert.equal(updates(calls).length, 0);
  assert.match(fee.querySelector(".feeerr").textContent, /at most two decimals/);
  assert.ok(fee.querySelector(".feeedit input"), "the editor closed on a bad value");
  assert.equal(fee.querySelector(".feeedit input").value, "3.225");
});

test("a failed save keeps the editor open with the error", async () => {
  const { w, calls, ctl } = await openPricing();
  ctl.failNext = true;   // the next write fails the way RLS would
  const { fee, input, save } = openEditor(w, 0);
  input.value = "4.00";
  save.click();
  await flush();

  assert.equal(updates(calls).length, 1);
  assert.match(fee.querySelector(".feeerr").textContent, /permission denied/);
  assert.equal(fee.querySelector(".feeedit input").value, "4.00");
  assert.ok(fee.classList.contains("editing"), "the editor closed on a failed save");
});

test("only one row edits at a time", async () => {
  const { w } = await openPricing();
  const first = openEditor(w, 0);
  first.input.value = "50.00";
  const second = openEditor(w, 1);

  assert.ok(second.input, "the second row did not open an editor");
  assert.equal(w.document.querySelectorAll("#priceList .feeedit").length, 1);
  assert.equal(feeText(w, 0), "$3.22", "the abandoned edit leaked into the row");
});

test("the price table has no delete column", async () => {
  const { w } = await openPricing();
  const heads = [...w.document.querySelectorAll("#priceList thead th")].map(th => th.textContent);
  assert.deepEqual(heads, ["Form ID", "Description", "Fee", "Section", "Updated"]);
  assert.equal(w.document.querySelector("#priceList td.act"), null);
  assert.equal([...w.document.querySelectorAll("#priceList tbody button")].length, 0);
});

test("adding a form inserts it and re-sorts into place", async () => {
  const { w, calls } = await openPricing();
  const set = (id, v) => { w.document.getElementById(id).value = v; };
  set("pfId", "  0119  "); set("pfDesc", "Buyers Guide"); set("pfFee", "2.00"); set("pfSection", "A");
  w.document.getElementById("pfAdd").click();
  await flush();

  const ins = calls.find(c => c.ops.includes("insert"));
  assert.deepEqual(plain(ins.row),
    { form_id: "0119", description: "Buyers Guide", transaction_fee: 2, section: "A", updated_by: EMAIL });

  const ids = [...w.document.querySelectorAll("#priceList tbody tr")].map(tr => tr.children[0].textContent);
  assert.deepEqual(ids, ["0119", "0122", "8721", "IDA-1"]);
  assert.equal(w.document.getElementById("pfId").value, "");
});

test("adding without a form id, or with a bad fee, writes nothing", async () => {
  const { w, calls } = await openPricing();
  w.document.getElementById("pfFee").value = "1.00";
  w.document.getElementById("pfAdd").click();
  await flush();
  assert.match(w.document.getElementById("pfMsg").textContent, /Form ID is required/);

  w.document.getElementById("pfId").value = "0130";
  w.document.getElementById("pfFee").value = "free";
  w.document.getElementById("pfAdd").click();
  await flush();
  assert.match(w.document.getElementById("pfMsg").textContent, /at most two decimals/);

  assert.equal(calls.filter(c => c.ops.includes("insert")).length, 0);
});

test("saving the monthly minimum validates and updates id=1", async () => {
  const { w, calls } = await openPricing();
  const min = w.document.getElementById("minFee");

  min.value = "0";
  w.document.getElementById("minBtn").click();
  await flush();
  assert.match(w.document.getElementById("minMsg").textContent, /positive amount/);
  assert.equal(calls.filter(c => c.table === "rr_report_settings" && c.ops.includes("update")).length, 0);

  min.value = "400";
  w.document.getElementById("minBtn").click();
  await flush();
  const write = calls.filter(c => c.table === "rr_report_settings" && c.ops.includes("update"));
  assert.equal(write.length, 1);
  assert.deepEqual(plain(write[0].patch), { minimum_monthly_fee: 400 });
  assert.deepEqual(plain(write[0].eq), { id: 1 });
  assert.equal(min.value, "400.00");
});
