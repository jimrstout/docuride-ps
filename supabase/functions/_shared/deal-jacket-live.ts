// _shared/deal-jacket-live.ts
//
// The real calls behind _shared/deal-jacket-move.ts: the private fni-contracts
// bucket, WorkDrive through DocuRide DC's Zoho client, and fni.agreement_products.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { MoveDeps } from "./deal-jacket-move.ts";
import { listFolderItems, trashFile, uploadPdf, workDriveProblem } from "./workdrive.ts";
import { HOLD_BUCKET } from "./contract-documents.ts";

export { HOLD_BUCKET };

export function liveMoveDeps(supabase: SupabaseClient): MoveDeps {
  return {
    async download(path) {
      const { data, error } = await supabase.storage.from(HOLD_BUCKET).download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    listJacket: listFolderItems,
    trash: trashFile,
    upload: uploadPdf,
    async record(rowId, fields) {
      const { error } = await supabase.schema("fni").from("agreement_products").update(fields).eq("id", rowId);
      if (error) throw new Error(`The move could not be recorded (${error.code ?? "error"}).`);
    },
    now: () => new Date().toISOString(),
    problem(err) {
      console.error("deal-jacket-move: WorkDrive refused", {
        status: (err as { status?: unknown })?.status ?? null,
        code: (err as { code?: unknown })?.code ?? null,
      });
      return err instanceof Error && /could not be recorded/.test(err.message)
        ? `Saved to the Deal Jacket, but ${err.message.charAt(0).toLowerCase()}${err.message.slice(1)} Run the move again.`
        : workDriveProblem(err);
    },
  };
}
