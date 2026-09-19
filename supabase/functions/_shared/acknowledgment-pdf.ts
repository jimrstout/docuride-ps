// _shared/acknowledgment-pdf.ts
//
// Renders the acceptance and decline acknowledgment.
//
// pdf-lib is passed in rather than imported, so the same renderer runs under
// Deno (from esm.sh) and under Node in the test suite (from npm). A compliance
// document whose layout nobody has asserted on is a document nobody should
// rely on, and this is what makes asserting on it possible.

import { planTotals, selectRate, toCents, monthlyPayment } from "./money.ts";
import { signatureLine, toTopLeft } from "./signature-map.ts";

// Structural types, so this file needs no pdf-lib import of its own.
export interface PdfDeps {
  PDFDocument: { create(): Promise<AnyDoc> };
  StandardFonts: { Helvetica: unknown; HelveticaBold: unknown };
  rgb: (r: number, g: number, b: number) => unknown;
}
type AnyDoc = {
  embedFont(f: unknown): Promise<AnyFont>;
  addPage(size: [number, number]): AnyPage;
  getPages(): AnyPage[];
  save(): Promise<Uint8Array>;
};
type AnyFont = { widthOfTextAtSize(t: string, s: number): number };
type AnyPage = {
  drawText(t: string, o: Record<string, unknown>): void;
  drawRectangle(o: Record<string, unknown>): void;
};

export interface AckDecision {
  product_code: string;
  product_name: string;
  disposition: "Included" | "Managed by Customer";
  customer_price: number | null;
  term_months: number | null;
  coverage_duration: string | null;
}

export interface AckInput {
  session_id: string;
  store_name: string;
  buyer_display_name: string | null;
  vehicle: string;
  vin: string | null;
  mode: string | null;
  /** The lender's principal, not the balance due on the unit. */
  principal: number | null;
  apr: number | null;
  interest_rate: number | null;
  term_months: number | null;
  decisions: AckDecision[];
  /** Injected so the document is reproducible in tests. */
  generated_at?: Date;
}

export interface AckOutput {
  bytes: Uint8Array;
  filename: string;
  signatureMapLine: string;
  page: number;
  totals: ReturnType<typeof planTotals> | null;
  rateLabel: string | null;
}

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 54;
const SIG_W = 230;
const SIG_H = 34;

function usd(n: number): string {
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export async function renderAcknowledgment(
  deps: PdfDeps,
  input: AckInput
): Promise<AckOutput> {
  const { PDFDocument, StandardFonts, rgb } = deps;
  const now = input.generated_at ?? new Date();

  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.05, 0.126, 0.169);
  const grey = rgb(0.39, 0.44, 0.48);
  const orange = rgb(0.741, 0.357, 0.169);
  const hair = rgb(0.85, 0.87, 0.87);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  const line = (
    text: string,
    o: { size?: number; font?: AnyFont; color?: unknown; gap?: number } = {}
  ) => {
    const size = o.size ?? 10;
    if (y < MARGIN + 130) newPage();
    page.drawText(text, {
      x: MARGIN,
      y,
      size,
      font: o.font ?? regular,
      color: o.color ?? ink,
    });
    y -= size + (o.gap ?? 5);
  };

  const rule = () => {
    page.drawRectangle({ x: MARGIN, y: y + 4, width: PAGE_W - MARGIN * 2, height: 0.7, color: hair });
    y -= 12;
  };

  /** Wrapped so a long sentence is never clipped at the page edge. */
  const paragraph = (text: string, size = 9) => {
    const max = PAGE_W - MARGIN * 2;
    let cur = "";
    for (const w of text.split(/\s+/)) {
      const trial = cur ? `${cur} ${w}` : w;
      if (regular.widthOfTextAtSize(trial, size) > max) {
        line(cur, { size, color: grey, gap: 2 });
        cur = w;
      } else cur = trial;
    }
    if (cur) line(cur, { size, color: grey, gap: 2 });
  };

  const pair = (label: string, value: string, strong = false) => {
    if (y < MARGIN + 130) newPage();
    const f = strong ? bold : regular;
    page.drawText(label, { x: MARGIN, y, size: 10, font: f, color: ink });
    const w = f.widthOfTextAtSize(value, 10);
    page.drawText(value, { x: PAGE_W - MARGIN - w, y, size: 10, font: f, color: ink });
    y -= 16;
  };

  page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: orange });

  line(input.store_name.toUpperCase(), { size: 8, color: grey, gap: 10 });
  line("What you were shown, and what you decided", { size: 17, font: bold, gap: 4 });
  line(input.vehicle + (input.vin ? `   VIN ${input.vin}` : ""), { size: 9, color: grey, gap: 3 });
  line(`Prepared for ${input.buyer_display_name ?? "the buyer"}`, { size: 9, color: grey, gap: 16 });

  const rate = selectRate(input.apr, input.interest_rate);
  const term = input.term_months;
  const included = input.decisions.filter((d) => d.disposition === "Included");

  const totals =
    input.principal !== null && rate !== null && term !== null && term > 0
      ? planTotals(input.principal, included.map((d) => d.customer_price ?? 0), rate.ratePercent, term)
      : null;

  // Every product presented, not only the ones included.
  line("PLANS PRESENTED", { size: 8, font: bold, gap: 8 });
  rule();

  if (input.decisions.length === 0) {
    paragraph("No protection plans were offered for this unit.");
    y -= 6;
  }

  for (const d of input.decisions) {
    const isIncluded = d.disposition === "Included";
    line(d.product_name, { size: 11, font: bold, gap: 2 });

    const bits: string[] = [];
    const duration = d.coverage_duration ?? (d.term_months ? `${d.term_months} months` : null);
    if (duration) bits.push(duration);
    if (isIncluded && d.customer_price !== null) {
      bits.push(usd(d.customer_price));
      if (rate !== null && term !== null && term > 0) {
        bits.push(`${usd(toCents(monthlyPayment(d.customer_price, rate.ratePercent, term)))}/month`);
      }
    }
    if (bits.length > 0) line(bits.join("   -   "), { size: 9, color: grey, gap: 2 });

    // The customer's own words. Not an enum token, and never "Not Selected".
    line(d.disposition, { size: 9, font: bold, color: isIncluded ? ink : grey, gap: 10 });
  }

  y -= 4;
  line("PAYMENT", { size: 8, font: bold, gap: 8 });
  rule();

  if (totals && rate) {
    pair("Vehicle payment", usd(totals.vehiclePayment));
    pair("Plan payment", usd(totals.planPayment));
    pair("Total monthly payment", usd(totals.totalPayment), true);
    y -= 2;
    // Whichever rate was used names itself. Never one label over the other's value.
    line(`${rate.label}: ${rate.ratePercent}%     Term: ${term} months`, { size: 9, color: grey, gap: 14 });
  } else {
    paragraph("Financing terms were not finalized when this plan was prepared, so no payment is shown.");
    y -= 10;
  }

  y -= 4;
  line("WHAT THIS MEANS", { size: 8, font: bold, gap: 8 });
  rule();
  paragraph("These protection plans are optional. Declining any of them does not affect your credit approval or the terms of your sale.");
  paragraph("Pricing was presented by the system rather than negotiated. The prices above are the prices offered to every customer for this machine at this store.");
  paragraph("Your signature confirms that these plans were presented to you and that the decisions recorded above are the ones you made. It is not a purchase of anything marked Managed by Customer.");

  // Because this document is generated here rather than returned by a provider,
  // its coordinates are known at generation time. That makes the acknowledgment
  // the first external document in the pipeline whose signature placement is
  // automatic rather than manual.
  y -= 20;
  if (y < MARGIN + 80) newPage();

  const sigBottom = y - SIG_H;
  page.drawRectangle({
    x: MARGIN, y: sigBottom, width: SIG_W, height: SIG_H,
    borderColor: rgb(0.78, 0.8, 0.81), borderWidth: 0.7,
  });
  page.drawText("Buyer signature", { x: MARGIN, y: sigBottom - 12, size: 8, font: regular, color: grey });
  page.drawText(
    `Session ${input.session_id}   ${input.mode === "staff-presented" ? "Presented by dealership staff" : "Self-guided"}   ${now.toISOString()}`,
    { x: MARGIN, y: sigBottom - 26, size: 7, font: regular, color: grey }
  );

  const pageNumber = pdf.getPages().indexOf(page) + 1;
  const filename = `FNI_ACK_${input.session_id.slice(0, 8)}.pdf`;
  const { top, bottom } = toTopLeft(PAGE_H, sigBottom, SIG_H);

  return {
    bytes: await pdf.save(),
    filename,
    page: pageNumber,
    signatureMapLine: signatureLine({
      filename,
      page: pageNumber,
      left: MARGIN,
      top,
      right: MARGIN + SIG_W,
      bottom,
    }),
    totals,
    rateLabel: rate?.label ?? null,
  };
}
