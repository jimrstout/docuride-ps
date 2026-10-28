// lib/rate-again.ts: when Rate again is offered on Details.
//
// Rate again rates the deal any time, with its current inputs, whatever the
// rating says (fni-rate-vehicle, rate_again). It is offered to a signed-in
// person only, and not while a submit is running or its outcome is unknown,
// or while a contract on the deal is live: that contract was written on the
// offer a fresh rating would replace. fni-rate-vehicle refuses the same
// cases itself.
//
// No imports, so a Node test can load it.

export function rateAgainAvailable(input: {
  signedIn: boolean;
  submitState: string | null | undefined;
  /** The deal's contracts that hold their slot: Live or Submit Status Unknown. */
  liveContracts: number;
}): boolean {
  return input.signedIn && (input.submitState ?? "Idle") === "Idle" && input.liveContracts === 0;
}
