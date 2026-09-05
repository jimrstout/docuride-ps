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

test("clicking a fee, editing it and pressing Enter fires the right update", async () => {
  const { w, calls } = await openPricing();
  const fee = w.document.querySelectorAll("#priceList tbody tr")[1].querySelector("td.fee");
  assert.equal(fee.textContent, "$0.41");

  fee.click();
  const input = fee.querySelector("input");
  assert.ok(input, "fee cell did not become an input");
  assert.equal(input.value, "0.41");

  input.value = "1.25";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();

  const write = calls.filter(c => c.table === "rr_form_prices" && c.ops.includes("update"));
  assert.equal(write.length, 1);
  assert.deepEqual(plain(write[0].patch), { transaction_fee: 1.25, updated_by: EMAIL });
  assert.deepEqual(plain(write[0].eq), { form_id: "8721" });

  const after = [...w.document.querySelectorAll("#priceList tbody tr")][1].querySelector("td.fee");
  assert.equal(after.textContent, "$1.25");
});

test("Escape cancels a fee edit and writes nothing", async () => {
  const { w, calls } = await openPricing();
  const fee = w.document.querySelector("#priceList tbody tr td.fee");
  fee.click();
  const input = fee.querySelector("input");
  input.value = "99.99";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flush();

  assert.equal(calls.filter(c => c.ops.includes("update") && c.table === "rr_form_prices").length, 0);
  assert.equal(w.document.querySelector("#priceList tbody tr td.fee").textContent, "$3.22");
});

test("a fee with three decimals is rejected without a write", async () => {
  const { w, calls } = await openPricing();
  const fee = w.document.querySelector("#priceList tbody tr td.fee");
  fee.click();
  const input = fee.querySelector("input");
  input.value = "3.225";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();

  assert.equal(calls.filter(c => c.ops.includes("update") && c.table === "rr_form_prices").length, 0);
  assert.match(w.document.getElementById("pfMsg").textContent, /Not a fee: 3\.225/);
  assert.equal(w.document.querySelector("#priceList tbody tr td.fee").textContent, "$3.22");
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

test("deleting a price row confirms, deletes by form_id and drops the row", async () => {
  const { w, calls } = await openPricing();
  const rm = w.document.querySelector("#priceList tbody tr td.act button");
  assert.equal(rm.textContent, "✕");
  rm.click();
  await flush();

  const del = calls.find(c => c.ops.includes("delete"));
  assert.equal(del.table, "rr_form_prices");
  assert.deepEqual(plain(del.eq), { form_id: "0122" });
  assert.equal(w.document.querySelectorAll("#priceList tbody tr").length, 2);
});
