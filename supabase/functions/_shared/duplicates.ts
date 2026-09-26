// _shared/duplicates.ts
//
// The rules that keep one deal to one session and one product to one live
// contract, in one place so that every caller applies the same ones.
//
// ── Why these are worth their own module ────────────────────────────────
// Each rule is a couple of lines, and each was previously absent from a
// different function, which is the pattern that produces a duplicate: the CRM
// button, the submit endpoint and the staff screen each had a partial view of
// "has this already happened". The predicates live here and the three of them
// import the same ones.

/** A contract row as these rules need to see it. */
export interface ContractRef {
  provider_product_id: string;
  contract_number: string | null;
  product_name: string | null;
  status: string;
}

/**
 * A contract that occupies its product's slot.
 *
 * Unknown counts. We may hold a real contract for that product and the point of
 * the state is that nobody yet knows, so treating it as free is precisely the
 * assumption that creates a second one.
 */
export function occupiesSlot(c: ContractRef): boolean {
  return c.status === "Live" || c.status === "Submit Status Unknown";
}

/** Contracts blocking further submission, by provider product id. */
export function blockingByProduct(contracts: ContractRef[]): Map<string, ContractRef> {
  const out = new Map<string, ContractRef>();
  for (const c of contracts) {
    if (occupiesSlot(c)) out.set(c.provider_product_id, c);
  }
  return out;
}

/** How a contract reads in a sentence to staff. */
export function describeContract(c: ContractRef): string {
  const name = c.product_name ?? c.provider_product_id;
  const number = c.contract_number ?? "no contract number recorded";
  return c.status === "Submit Status Unknown"
    ? `${name} (${number}, submit status unknown)`
    : `${name} (${number})`;
}

/**
 * The sentence staff see when a deal comes in from the CRM again and paperwork
 * already exists on it.
 *
 * Jim's words, and they are the right ones: it states the fact and lists the
 * numbers, and it does not offer to do anything, because nothing should be
 * done automatically to a session that has contracts against it.
 */
export function contractsAlreadySubmittedMessage(contracts: ContractRef[]): string {
  const live = contracts.filter(occupiesSlot);
  const numbers = live
    .map((c) => c.contract_number)
    .filter((n): n is string => typeof n === "string" && n.trim() !== "");

  return numbers.length > 0
    ? `Contracts already submitted on this deal: ${numbers.join(", ")}`
    : `Contracts already submitted on this deal`;
}

// ── The submit lock ───────────────────────────────────────────────────────

/** Session columns the lock reasoning reads. */
export interface SubmitLockState {
  submit_state: string;
  submit_started_at: string | null;
  submit_detail: string | null;
}

/**
 * How long an In Progress lock may stand before it is reported as unknown.
 *
 * A submit that reached TecAssured and never came back is the case this exists
 * for: two of ours hung at 5 and 55 seconds before the pruning fix, and an Edge
 * Function isolate can be torn down mid-flight. Ten minutes is far longer than
 * any real submit and short enough that staff are not left staring at
 * "In Progress" for an afternoon.
 */
export const SUBMIT_LOCK_STALE_MS = 10 * 60 * 1000;

export function lockIsStale(state: SubmitLockState, now = Date.now()): boolean {
  if (state.submit_state !== "In Progress") return false;
  if (!state.submit_started_at) return true;
  const started = Date.parse(state.submit_started_at);
  return !Number.isFinite(started) || now - started > SUBMIT_LOCK_STALE_MS;
}

/**
 * Why a submit may not start, or null when it may.
 *
 * A stale In Progress is NOT reported as "try again in a moment". It is
 * reported as unknown, because a submit that went quiet after reaching the
 * provider may well have created paperwork, and the caller converts the state
 * to match. Releasing it on a timer would be guessing that nothing was created,
 * which is the guess that produces duplicates.
 */
export function submitRefusal(state: SubmitLockState, now = Date.now()): string | null {
  if (state.submit_state === "Submit Status Unknown") {
    return (
      "A previous submit on this session reached TecAssured and we never learned " +
      "whether it created contracts. Check in TecAssured before submitting again. " +
      (state.submit_detail ? `Detail: ${state.submit_detail}` : "")
    ).trim();
  }

  if (state.submit_state === "In Progress") {
    return lockIsStale(state, now)
      ? "A previous submit on this session started and never finished, so its " +
        "outcome is unknown. Check in TecAssured before submitting again."
      : "A submit is already in progress for this session. Wait for it to finish.";
  }

  return null;
}

// ── Case 3: the same machine on two deals ────────────────────────────────
//
// A CRM duplicate is not something DocuRide can fix, and not something it
// should guess at either: two deals on one VIN is sometimes a mistake and
// sometimes a re-write of a deal that fell through. Both look identical from
// here. So the rule is to say what we can see and let staff decide, which is
// why this is a warning on the verify screen and not a refusal anywhere.

/** A session nobody has finished with. The statuses are fni.sessions' own. */
export const TERMINAL_SESSION_STATUSES = ["Finalized", "Written Back", "Cancelled"];

export interface OpenSessionRef {
  id: string;
  deal_number: string | null;
  status: string;
  expires_at: string | null;
}

/**
 * Open means: not finished, and not lapsed.
 *
 * Expiry counts because a stale test session on the same VIN is noise, not a
 * duplicate deal, and a warning nobody needs is a warning everybody learns to
 * ignore.
 */
export function sessionIsOpen(s: OpenSessionRef, now = Date.now()): boolean {
  if (TERMINAL_SESSION_STATUSES.includes(s.status)) return false;
  if (s.expires_at && Date.parse(s.expires_at) <= now) return false;
  return true;
}

/** The warning, in Jim's words. One line per other session. */
export function duplicateVinWarning(others: OpenSessionRef[]): string | null {
  if (others.length === 0) return null;
  const numbers = others.map((o) => o.deal_number ?? "number not set");
  if (numbers.length === 1) {
    return `Another open session exists for this VIN: Deal #${numbers[0]}.`;
  }
  return `Other open sessions exist for this VIN: ${numbers.map((n) => `Deal #${n}`).join(", ")}.`;
}
