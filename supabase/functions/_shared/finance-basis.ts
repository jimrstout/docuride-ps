// _shared/finance-basis.ts
//
// One answer to "what are this deal's finance figures", for the screen and for
// the provider.
//
// ── The bug this exists to end ────────────────────────────────────────────────
// fni.sessions carries two sets of finance columns, and until now two different
// parts of DocuRide read different ones:
//
//   the planner, and the acknowledgment PDF    tila_amount_financed,
//                                             interest_rate, finance_term_total
//   the Verify sheet, and the rate request     amount_financed, apr, finance_term
//
// On deal 13759 the first set holds 6.99% over 60 months with Roadrunner
// Financial attached, and the second holds null and null. So the customer's own
// screen showed "6.99% · 60 months" while the staff screen said Term and APR
// were Missing and refused to let anybody rate. Worse, the rate request was
// built from the same nulls, so pressing through would have been refused by
// TecAssured for missing finance.term and finance.apr.
//
// Which set is right is not a matter of taste. SPEC_CORRECTIONS.md §1 settled it
// against a real contract, to the penny: the term is Term_Months (or the TILA
// payment counts added up), the rate is TILA_APR where TILA ran and
// Interest_Rate otherwise, and the principal the lender amortizes is
// TILA_Amount_Financed. `apr` and `finance_term` are the columns
// fni-session-start happens to fill from TILA_APR and TILA_Pmt1_Count, and on a
// deal where TILA has not been calculated they are simply empty.
//
// So there is one resolver, it is _shared/money.ts's resolvePaymentBasis -- the
// one already proved against a contract -- and everything reads through here.

import { resolvePaymentBasis, selectRate, type PaymentBasisKind } from "./money.ts";

/** The session columns the finance figures come from. All optional: a caller
 *  that predates one of them still typechecks, and a missing column reads as
 *  absent rather than as zero. */
export interface FinanceSource {
  finance_type?: unknown;
  apr?: unknown;
  interest_rate?: unknown;
  finance_term?: unknown;
  finance_term_total?: unknown;
  amount_financed?: unknown;
  tila_amount_financed?: unknown;
  lienholder_name?: unknown;
}

export interface FinanceFigures {
  kind: PaymentBasisKind;
  /** Months. Null on a cash deal, and null when nothing carries it. */
  termMonths: number | null;
  /** Percent. Zero is a real rate, so null is the only "we do not know". */
  ratePercent: number | null;
  rateSource: "apr" | "interest_rate" | null;
  /** "Annual percentage rate" or "Interest rate". What to call it on screen. */
  rateLabel: string | null;
  /** What the lender amortizes, which is not always the balance due. */
  principal: number | null;
  /** The lienholder, or null on a cash deal. */
  lenderName: string | null;
  /** This deal is financed, so the three finance figures are real questions. */
  financed: boolean;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Is this deal financed?
 *
 * resolvePaymentBasis decides that from the lienholder alone, because that is
 * what the DocuRide record itself does -- it hides the remaining lienholder
 * fields on the same condition. That is right for the planner, which only ever
 * reads what the CRM said.
 *
 * The Verify screen is different: deal type is editable there, and it is the
 * field a person corrects when the CRM has a deal wrong. So finance_type is the
 * authority where it is set, and the lienholder is what it was derived from.
 * Without this, somebody changing a deal from Cash to Finance would still see
 * zeroes, because no lienholder had been attached yet.
 */
function isFinanced(src: FinanceSource): boolean {
  const type = str(src.finance_type);
  if (type !== null) {
    const lower = type.toLowerCase();
    if (lower === "cash" || lower === "none") return false;
    return true;
  }
  return str(src.lienholder_name) !== null;
}

export function financeFigures(src: FinanceSource): FinanceFigures {
  const financed = isFinanced(src);
  const lenderName = str(src.lienholder_name);

  if (!financed) {
    return {
      kind: "cash",
      termMonths: null,
      ratePercent: null,
      rateSource: null,
      rateLabel: null,
      principal: null,
      lenderName: null,
      financed: false,
    };
  }

  const basis = resolvePaymentBasis({
    tilaAmountFinanced: num(src.tila_amount_financed),
    amountFinanced: num(src.amount_financed),
    apr: num(src.apr),
    interestRate: num(src.interest_rate),
    // finance_term_total is the corrected column (Term_Months, or the TILA
    // payment counts added up). finance_term is the old one, kept as a fallback
    // so a session written before the correction still reports a term.
    termMonths: num(src.finance_term_total) ?? num(src.finance_term),
    // Non-empty so resolvePaymentBasis's own cash test passes: `financed` above
    // has already answered that question, from the field staff can correct.
    lienholderName: lenderName ?? "financed",
  });

  // ── The rate follows selectRate's precedence, APR first ───────────────────
  // resolvePaymentBasis's lienholder branch reports interest_rate outright,
  // because on a financed deal with no TILA that is the rate the payment is
  // amortized at and an APR usually does not exist yet. Right for the payment
  // math, wrong here: APR is an editable field on the Verify screen, and
  // somebody who types one has corrected the rate. Ignoring it would accept the
  // edit, store it, and quote the old rate to the provider anyway.
  //
  // So the rate is selectRate(apr, interest_rate) -- the documented precedence,
  // and what resolvePaymentBasis itself uses in both its other branches.
  const rate = selectRate(num(src.apr), num(src.interest_rate));

  return {
    kind: basis.kind,
    termMonths: basis.termMonths,
    ratePercent: rate?.ratePercent ?? basis.ratePercent,
    rateSource: rate?.source ?? basis.rateSource,
    rateLabel: rate?.label ?? basis.rateLabel,
    principal: basis.principal,
    lenderName,
    financed: true,
  };
}
