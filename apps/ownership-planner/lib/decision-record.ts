// lib/decision-record.ts
//
// The record on the last screen: every plan the customer was shown, and what
// they decided about each.
//
// One group per family, in the order the product screens came, because that is
// how the customer met them: "Option 2 of 5", under the same goal. Inside a
// group, every tier that was on the screen. The tier they settled on in a family
// they included is Chosen, with its price; every other tier is Declined.
//
// Pure, with no imports but types, so a Node test can build the record from a
// session and check it line by line.

import type { Disposition } from "./types";

/** One tier as it appeared on its family's screen. */
export interface RecordTierInput {
  code: string;
  name: string;
  /** The term in force for that tier, in words: "4 years", "12 months". */
  term: string | null;
}

/** One family, as the planner resolved it. */
export interface RecordFamilyInput {
  code: string;
  goal: string;
  tiers: RecordTierInput[];
  /** The tier in force: the one the customer settled on, else the first. */
  tierInForce: string;
  decision: Disposition | undefined;
  /** What the tier in force costs, options included. Null when unpriced. */
  price: number | null;
}

export interface RecordLine {
  code: string;
  name: string;
  term: string | null;
  chosen: boolean;
  /** The price, for a chosen line only. */
  price: number | null;
  /** What the line says about the decision: Chosen, Declined, Not yet decided. */
  decision: string;
}

export interface RecordGroup {
  code: string;
  goal: string;
  /** "Option 2 of 5", as on the product screen. */
  position: string;
  lines: RecordLine[];
}

export function decisionRecord(families: RecordFamilyInput[]): RecordGroup[] {
  return families.map((f, i) => ({
    code: f.code,
    goal: f.goal,
    position: `Option ${i + 1} of ${families.length}`,
    lines: f.tiers.map((t) => {
      const chosen = f.decision === "Included" && t.code === f.tierInForce;
      return {
        code: t.code,
        name: t.name,
        term: t.term,
        chosen,
        price: chosen ? f.price : null,
        // A family nobody has decided yet is not a decline. The planner will
        // not let a customer past a product screen undecided, so this only
        // shows on a session reopened part way through.
        decision: chosen ? "Chosen" : f.decision === undefined ? "Not yet decided" : "Declined",
      };
    }),
  }));
}
