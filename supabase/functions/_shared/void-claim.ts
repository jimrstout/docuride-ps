// _shared/void-claim.ts
//
// One void at a time per contract.
//
// Two Voids for the same contract a moment apart (a double click, two tabs)
// used to both read it as Live and both call TecAssured: the second got a
// confusing refusal, or wrote its own reason and time over the first. Now a
// void claims the contract row first, with a conditional UPDATE Postgres
// applies atomically: of two requests, exactly one gets the row back, and the
// other is told plainly and sends nothing. The claim is cleared when the void
// ends, whatever the outcome. A claim older than VOID_CLAIM_STALE_MS is taken
// to be abandoned (the function stopped mid-way) and can be taken over.

export const VOID_CLAIM_STALE_MS = 3 * 60 * 1000;

/** PostgREST's or-filter for a row nobody is voiding, or whose claim is stale. */
export function unclaimedFilter(now: Date): string {
  const staleBefore = new Date(now.getTime() - VOID_CLAIM_STALE_MS).toISOString();
  return `void_started_at.is.null,void_started_at.lt.${staleBefore}`;
}

export function alreadyVoidingMessage(contract: string): string {
  return `${contract} is already being voided. Wait a moment, then reload the page to see the result. Nothing more was sent to TecAssured.`;
}
