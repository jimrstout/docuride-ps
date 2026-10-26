// _shared/dc-deal-folders.ts
//
// A deal's WorkDrive folders and buyer name, as DocuRide DC holds them in
// dc.deals. Read only: only DocuRide DC makes or changes a deal's folders.

import { dcDb } from "./dc-zoho.ts";
import type { DealFolders } from "./contract-documents.ts";

/** The deal in DocuRide DC: by Zoho id first, then by deal number. */
export async function dcDealFolders(zohoId: string | null, dealNumber: string | null): Promise<DealFolders | null> {
  const sql = dcDb();
  const cols = sql`deal_number, buyer_display_name, deal_jacket_folder_id, signed_documents_folder_id`;
  if (zohoId) {
    const rows = await sql`select ${cols} from dc.deals where zoho_id = ${zohoId} limit 1`;
    if (rows[0]) return rows[0] as unknown as DealFolders;
  }
  if (dealNumber) {
    const rows = await sql`select ${cols} from dc.deals where deal_number = ${dealNumber} order by updated_at desc limit 2`;
    // Two DC deals with one number is not a guess to make with somebody's paperwork.
    if (rows.length === 1) return rows[0] as unknown as DealFolders;
  }
  return null;
}
