// lib/rate-again.ts: when Rate again is offered on Details.
//
// Rate again rates the deal any time, with its current inputs, whatever the
// rating says (fni-rate-vehicle, rate_again). It is offered to a signed-in
// person only, and not while a submit is running or its outcome is unknown.
// A live contract does not stop it (2026-10-30): products can be added after
// a contract, and a rating never touches a purchased product
// (supabase/functions/_shared/purchased.ts). fni-rate-vehicle refuses the
// same cases itself.
//
// No imports, so a Node test can load it.

export function rateAgainAvailable(input: {
  signedIn: boolean;
  submitState: string | null | undefined;
}): boolean {
  return input.signedIn && (input.submitState ?? "Idle") === "Idle";
}
