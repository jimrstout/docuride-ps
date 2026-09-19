// The acceptance and decline acknowledgment.
//
// This is the document that makes a self-guided F&I session defensible, so the
// things that make it defensible are asserted rather than eyeballed: that every
// product presented appears, that declines appear as declines, that the payment
// reconciles, and that the signature coordinates land on the page the signature
// box is actually drawn on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfText as textOf } from "./_pdf-text.mjs";
import { renderAcknowledgment } from "../supabase/functions/_shared/acknowledgment-pdf.ts";

const DEPS = { PDFDocument, StandardFonts, rgb };

const BASE = {
  session_id: "44e41c35-c501-4ee8-84ed-8858b6b9101f",
  store_name: "All Seasons Powersports & Equipment",
  buyer_display_name: "Test Buyer",
  vehicle: "2020 Can-Am Spyder RT",
  vin: "2BXNBDD24LV001706",
  mode: "self-guided",
  principal: 13930.94,
  apr: 8.5165,
  interest_rate: 7.84,
  term_months: 60,
  generated_at: new Date("2026-09-19T20:00:00.000Z"),
  decisions: [
    { product_code: "VSC", product_name: "Vehicle Service Contract", disposition: "Included",
      customer_price: 2225, term_months: 48, coverage_duration: "48 months or 48,000 miles" },
    { product_code: "GAP", product_name: "Guaranteed Asset Protection", disposition: "Managed by Customer",
      customer_price: null, term_months: 60, coverage_duration: "The life of your loan" },
    { product_code: "TW", product_name: "Tire and Wheel Protection", disposition: "Included",
      customer_price: 890, term_months: 36, coverage_duration: "36 months" },
    { product_code: "KEY", product_name: "Key and Remote Replacement", disposition: "Managed by Customer",
      customer_price: null, term_months: 60, coverage_duration: "60 months" },
  ],
};

test("produces a real PDF", async () => {
  const out = await renderAcknowledgment(DEPS, BASE);
  assert.ok(out.bytes.length > 1000);
  assert.equal(Buffer.from(out.bytes.slice(0, 5)).toString(), "%PDF-");
  const { pages } = await textOf(out.bytes);
  assert.ok(pages >= 1);
});

test("lists every product presented, not only the included ones", async () => {
  const out = await renderAcknowledgment(DEPS, BASE);
  const { raw } = await textOf(out.bytes);
  for (const d of BASE.decisions) {
    assert.ok(raw.includes(d.product_name), `${d.product_name} is missing from the document`);
  }
});

test("prints the neutral disposition wording, never 'Not Selected'", async () => {
  const out = await renderAcknowledgment(DEPS, BASE);
  const { raw } = await textOf(out.bytes);
  assert.ok(raw.includes("Managed by Customer"));
  assert.ok(raw.includes("Included"));
  assert.ok(!raw.includes("Not Selected"));
});

test("the payment reconciles and matches the planner", async () => {
  const out = await renderAcknowledgment(DEPS, BASE);
  // 2225 + 890 included on top of the real principal.
  assert.equal(out.totals.productTotal, 3115);
  assert.equal(out.totals.vehiclePayment, 285.93);
  assert.equal(
    Math.round((out.totals.vehiclePayment + out.totals.planPayment) * 100) / 100,
    out.totals.totalPayment
  );
});

test("names the rate it actually used", async () => {
  const withApr = await renderAcknowledgment(DEPS, BASE);
  assert.equal(withApr.rateLabel, "Annual percentage rate");

  const withoutApr = await renderAcknowledgment(DEPS, { ...BASE, apr: null });
  assert.equal(withoutApr.rateLabel, "Interest rate");
  const { raw } = await textOf(withoutApr.bytes);
  assert.ok(raw.includes("Interest rate"));
  assert.ok(!raw.includes("Annual percentage rate"));
});

test("the signature line points at the page the signature box is drawn on", async () => {
  const out = await renderAcknowledgment(DEPS, BASE);
  const [filename, page, left, top, right, bottom, signer] = out.signatureMapLine.split("|");

  assert.equal(filename, "FNI_ACK_44e41c35.pdf");
  assert.equal(Number(page), out.page);
  assert.equal(signer, "buyer");

  const { pages } = await textOf(out.bytes);
  assert.ok(Number(page) >= 1 && Number(page) <= pages, "signature page is outside the document");

  // A top-left origin box: bottom is below top, and the box keeps its size.
  assert.equal(Number(right) - Number(left), 230);
  assert.equal(Number(bottom) - Number(top), 34);
  assert.ok(Number(top) > 0 && Number(bottom) < 792);
});

test("is generated even when the customer included nothing", async () => {
  // The session most worth having a record of.
  const declined = BASE.decisions.map((d) => ({
    ...d, disposition: "Managed by Customer", customer_price: null,
  }));
  const out = await renderAcknowledgment(DEPS, { ...BASE, decisions: declined });

  assert.ok(out.bytes.length > 1000);
  assert.equal(out.totals.productTotal, 0);
  assert.equal(out.totals.planPayment, 0);
  assert.equal(out.totals.totalPayment, 285.93);

  const { raw } = await textOf(out.bytes);
  for (const d of BASE.decisions) assert.ok(raw.includes(d.product_name));
});

test("handles a unit with no offers at all", async () => {
  const out = await renderAcknowledgment(DEPS, { ...BASE, decisions: [] });
  const { raw } = await textOf(out.bytes);
  assert.ok(raw.includes("No protection plans were offered"));
  assert.ok(out.signatureMapLine.startsWith("FNI_ACK_"));
});

test("says so rather than inventing a payment when terms are not final", async () => {
  const out = await renderAcknowledgment(DEPS, {
    ...BASE, principal: null, apr: null, interest_rate: null, term_months: null,
  });
  assert.equal(out.totals, null);
  const { raw } = await textOf(out.bytes);
  assert.ok(raw.includes("not finalized"));
});

test("a long list of products still puts the signature on a real page", async () => {
  const many = Array.from({ length: 24 }, (_, i) => ({
    product_code: `P${i}`,
    product_name: `Protection Plan Number ${i}`,
    disposition: i % 2 ? "Included" : "Managed by Customer",
    customer_price: i % 2 ? 500 + i : null,
    term_months: 36,
    coverage_duration: "36 months",
  }));
  const out = await renderAcknowledgment(DEPS, { ...BASE, decisions: many });
  const { pages } = await textOf(out.bytes);
  assert.ok(pages > 1, "expected the document to flow onto more than one page");
  assert.equal(Number(out.signatureMapLine.split("|")[1]), out.page);
  assert.ok(out.page <= pages);
});
