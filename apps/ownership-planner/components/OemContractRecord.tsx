"use client";

// components/OemContractRecord.tsx: recording an OEM contract on Verify.
//
// The signed contract goes from the browser straight into the private
// oem-contracts bucket, through a one-time signed URL the server asks for, as
// a price sheet does. Once the file is there, the form submits as an ordinary
// form and the server records the contract. Nothing is sent to any provider:
// the contract was written on the OEM's own system.

import { useRef, useState } from "react";
import { useWorking, Working } from "@/components/Working";
import { oemContractUploadUrl, recordOemContract } from "@/app/console-actions";

const MAX_BYTES = 20 * 1024 * 1024;

export default function OemContractRecord({
  sessionId,
  selectedProductId,
}: {
  sessionId: string;
  selectedProductId: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<"idle" | "uploading" | "saving">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  // The page's working state: the upload is work of this form's own, so it
  // starts the job itself and the save that follows ends it.
  const area = useWorking();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const f = e.currentTarget;
    const path = f.elements.namedItem("document_path") as HTMLInputElement;
    if (path.value) return; // The file is up; let the form submit to the server.
    e.preventDefault();
    setProblem(null);

    const file = (f.elements.namedItem("document") as HTMLInputElement).files?.[0];
    const number = (f.elements.namedItem("contract_number") as HTMLInputElement).value.trim();
    if (number === "") return setProblem("Type the contract number from the OEM's system.");
    if (!file) return setProblem("Choose the signed contract to upload.");
    if (file.size > MAX_BYTES) return setProblem("The file is larger than 20 MB.");

    setState("uploading");
    area?.start({ scope: "panel", label: "Uploading the signed contract...", leave: null }, f, (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null);
    const started = await oemContractUploadUrl(sessionId, file.name);
    if ("error" in started) {
      setState("idle");
      area?.done();
      return setProblem(started.error);
    }

    // The same request shape Supabase's own upload-to-signed-URL sends.
    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file);
    const res = await fetch(started.signed_url, { method: "PUT", body, headers: { "x-upsert": "false" } });
    if (!res.ok) {
      setState("idle");
      area?.done();
      return setProblem("The file could not be uploaded. Try again shortly.");
    }

    path.value = started.document_path;
    setState("saving");
    form.current?.requestSubmit();
  }

  return (
    <form ref={form} action={recordOemContract} onSubmit={onSubmit} className="oem-record">
      <Working />
      <input type="hidden" name="session_id" value={sessionId} />
      <input type="hidden" name="selected_product_id" value={selectedProductId} />
      <input type="hidden" name="document_path" defaultValue="" />
      <label>
        <span>Contract number</span>
        <input name="contract_number" autoComplete="off" required />
      </label>
      <label>
        <span>Signed contract: PDF, JPG or PNG</span>
        <input type="file" name="document" accept=".pdf,.jpg,.jpeg,.png" required />
      </label>
      {problem ? <p className="note note--flag" role="alert">{problem}</p> : null}
      <button type="submit" className="btn btn--quiet" disabled={state !== "idle"} aria-busy={state !== "idle" || undefined}>
        {state !== "idle" ? <span className="btn-spinner" aria-hidden="true" /> : null}
        {state === "uploading" ? "Uploading…" : state === "saving" ? "Recording…" : "Record contract"}
      </button>
    </form>
  );
}
