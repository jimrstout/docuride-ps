// lib/crm-link.ts: the deal's DocuRide record in the CRM, to open in a new tab.
//
// The sale date is the CRM's, changed there only (docs section 24), so Details
// links straight to the record to keep the round trip short. The org and the
// module's tab were read from Zoho on 2026-10-30 (getOrganization: domain
// org735391176; getModuleByApiName("DocuRide"): CustomModule24). Neither is a
// secret: both appear in every CRM address staff already open.
//
// No imports, so a Node test can load it.

export const CRM_RECORD_BASE = "https://crm.zoho.com/crm/org735391176/tab/CustomModule24/";

/** The DocuRide record's address, or null without a well-formed record id. */
export function crmRecordUrl(recordId: string | null | undefined): string | null {
  return typeof recordId === "string" && /^\d{10,25}$/.test(recordId) ? `${CRM_RECORD_BASE}${recordId}` : null;
}

/** What Details says when the CRM has no sale date for the deal. */
export const NO_SALE_DATE_LINE = "There is no sale date in the CRM. Add the Sale Date in the CRM.";

/** Beside a Submit the sale date holds back, so the date is said only once. */
export const SUBMIT_HELD_FOR_DATE = "Submit opens on the sale date. See the sale date above.";

/** How often Details checks the CRM while the date line is showing. */
export const DATE_WATCH_MS = 30_000;
