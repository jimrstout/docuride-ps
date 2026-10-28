// _shared/contract-guard.ts
//
// Where a real contract call may go while DocuRide is being tested.
//
// TecAssured confirmed that contracts on its QA server are test documents and
// that any of them can be voided. So submit, document and void are allowed
// only against the QA server, and only for the deals named here or a session
// marked is_test. The production server is off limits until go-live, which is
// a decision for a person: see docs/multi-provider.md, "Go-live items".
//
// Pure, so a Node test holds the rule.

/** The only TecAssured host a contract call may reach. */
export const QA_HOST = "ratessys-qa.com";

/** Deals cleared for test contracts on the QA server. */
export const TEST_CONTRACT_DEALS = new Set(["13759"]);

/** Deals that must never be sent, whatever their session says. */
export const NEVER_CONTRACT_DEALS = new Set(["14957"]);

export interface GuardSession {
  deal_number: string | null;
  is_test: boolean | null;
}

/** The host of a provider's API address, lower case, or "" if it is not a URL. */
export function hostOf(apiBaseUrl: string | null | undefined): string {
  try {
    return new URL(String(apiBaseUrl ?? "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Why a contract call must not be made, in plain English, or null when it may.
 * `action` is what the sentence says was refused: "submitted", "fetched",
 * "voided".
 */
export function contractCallRefusal(
  session: GuardSession,
  apiBaseUrl: string | null | undefined,
  action: "submitted" | "fetched" | "voided",
  /** The provider record's name, for naming its test server. */
  vendor?: string | null
): string | null {
  const deal = String(session.deal_number ?? "").trim();
  if (hostOf(apiBaseUrl) !== QA_HOST) {
    return (
      `Contracts can only be ${action} on the ${vendor ? `${vendor} test server` : "provider's test server"} (${QA_HOST}) while DocuRide is ` +
      `being tested. This store's login points somewhere else, so nothing was sent.`
    );
  }
  if (NEVER_CONTRACT_DEALS.has(deal)) {
    return `Deal ${deal} is not cleared for test contracts, so nothing was sent.`;
  }
  if (!TEST_CONTRACT_DEALS.has(deal) && session.is_test !== true) {
    return (
      `Only deal ${[...TEST_CONTRACT_DEALS].join(", ")} or a session marked as a test can have contracts ` +
      `${action} while DocuRide is being tested. ${deal ? `Deal ${deal}` : "This deal"} is neither, so nothing was sent.`
    );
  }
  return null;
}
