// _shared/submit-outcome.ts
//
// What a /contract/submit answer says happened, product by product.
//
// TecAssured can report a submit as failed while StoneEagle has created some
// of the contracts. Deal 13437: Tire and Wheel was refused, Battery and Theft
// were created, the answer carried a top-level error, nothing was recorded,
// and a resubmit was refused as a duplicate. So the answer is read per
// contract, never by its top-level error alone:
//
//   Created    an entry with a contract number and no error of its own
//   Refused    an entry with its own error
//   Not known  a product the answer does not account for, or a contract
//              number we cannot tie to a product we sent
//
// Every created contract is recorded, whatever the top-level answer. If any
// product is not known, the session is parked at Submit Status Unknown and
// staff are told in plain English which ones, so nothing is guessed.
//
// Pure, so a Node test holds the rules.

import { refusalInPlainEnglish, sentenceStart } from "./price-cap.ts";

/** A product we sent, keyed the way TecAssured echoes it back. */
export interface AskedProduct {
  rateUniqueId: string;
  productName: string;
}

export interface ProductOutcome {
  product_name: string;
  rate_unique_id: string;
  outcome: "Created" | "Refused" | "Not known";
  contract_number: string | null;
  /** TecAssured's own words, for a refusal. */
  detail: string | null;
  /** The line staff read. */
  line: string;
}

export interface SubmitReading {
  /** The response's contract entries that are real paperwork, as sent. */
  created: Record<string, unknown>[];
  products: ProductOutcome[];
  /** Contract numbers TecAssured returned that match nothing we sent. */
  untied: string[];
  /** Nothing was created and every product was refused: a clear no. */
  refusedOutright: boolean;
  /** Something cannot be accounted for, so nobody may assume. */
  unknown: boolean;
  message: string;
}

function text(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `vendor` is the provider record's name, for the lines staff read. */
export function readSubmitResponse(response: unknown, asked: AskedProduct[], vendor = "the provider"): SubmitReading {
  const who = sentenceStart(vendor);
  const r = (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
  const topError = text(r.error);
  const entries = (Array.isArray(r.contracts) ? r.contracts : []).filter(
    (c): c is Record<string, unknown> => !!c && typeof c === "object"
  );

  const created = entries.filter((c) => text(c.contractNumber) !== "" && text(c.error) === "");
  const refused = entries.filter((c) => text(c.error) !== "");
  const rateOf = (c: Record<string, unknown>) => text(c.rateUniqueId ?? c.rateUnique);
  const askedRates = new Set(asked.map((a) => a.rateUniqueId));

  const products: ProductOutcome[] = asked.map((a) => {
    const made = created.find((c) => rateOf(c) === a.rateUniqueId);
    if (made) {
      const number = text(made.contractNumber);
      return {
        product_name: a.productName,
        rate_unique_id: a.rateUniqueId,
        outcome: "Created",
        contract_number: number,
        detail: null,
        line: `${a.productName}: created, contract ${number}.`,
      };
    }
    const no = refused.find((c) => rateOf(c) === a.rateUniqueId);
    if (no) {
      return {
        product_name: a.productName,
        rate_unique_id: a.rateUniqueId,
        outcome: "Refused",
        contract_number: null,
        detail: text(no.error),
        line: `${a.productName}: not created. ${refusalInPlainEnglish(no.error, a.productName, vendor)}`,
      };
    }
    // A clear refusal of the whole call, with no entries at all, is a no for
    // every product: TecAssured declined before creating anything.
    if (entries.length === 0 && topError !== "") {
      return {
        product_name: a.productName,
        rate_unique_id: a.rateUniqueId,
        outcome: "Refused",
        contract_number: null,
        detail: topError,
        line: `${a.productName}: not created. ${refusalInPlainEnglish(topError, a.productName, vendor)}`,
      };
    }
    return {
      product_name: a.productName,
      rate_unique_id: a.rateUniqueId,
      outcome: "Not known",
      contract_number: null,
      detail: null,
      line: `${a.productName}: ${who}'s answer does not say whether this contract was created.`,
    };
  });

  const untied = created.filter((c) => !askedRates.has(rateOf(c))).map((c) => text(c.contractNumber));
  const made = products.filter((p) => p.outcome === "Created").length;
  const notKnown = products.filter((p) => p.outcome === "Not known").length;
  const unknown = notKnown > 0 || untied.length > 0;
  const refusedOutright = made === 0 && !unknown;

  const lines = products.map((p) => p.line);
  if (untied.length > 0) {
    lines.push(
      `${who} also returned ${plural(untied.length, "contract", "contracts")} we cannot match to a product we sent: ${untied.join(", ")}.`
    );
  }

  let head: string;
  if (refusedOutright) {
    head = products.length === 1 ? `${who} did not create the contract.` : `${who} did not create any of the contracts.`;
  } else if (made === products.length && !unknown) {
    head = `Submitted. ${who} created ${plural(made, "contract", "contracts")}.`;
  } else {
    head = `${who} created ${made} of ${plural(products.length, "contract", "contracts")}.`;
  }
  const tail = unknown
    ? ` The session is marked Submit Status Unknown: check with ${vendor} for the products above before submitting again.`
    : "";

  return {
    created: created.filter((c) => askedRates.has(rateOf(c))),
    products,
    untied,
    refusedOutright,
    unknown,
    message: `${head} ${lines.join(" ")}${tail}`,
  };
}
