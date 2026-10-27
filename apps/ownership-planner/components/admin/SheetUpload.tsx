"use client";

// components/admin/SheetUpload.tsx: uploading a price sheet.
//
// The file goes from the browser straight into the private price-sheets bucket,
// through a one-time signed URL the server asks for. A sheet can be bigger than
// the admin area's server will accept in one request, so it never passes
// through it. Once the file is there, the form submits as an ordinary form and
// the server records the sheet and starts reading it.

import { useRef, useState } from "react";
import { useWorking, Working } from "@/components/Working";
import { createPriceSheet, priceSheetUploadUrl } from "@/app/console-actions";

const MAX_BYTES = 20 * 1024 * 1024;

export default function SheetUpload({
  providers,
  chosen,
}: {
  providers: { id: string; name: string }[];
  chosen: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<"idle" | "uploading" | "saving">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  // The page's working state: the upload is work of this form's own, so it
  // starts the job itself and the save that follows ends it.
  const area = useWorking();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const f = e.currentTarget;
    const path = f.elements.namedItem("file_path") as HTMLInputElement;
    if (path.value) return; // The file is up; let the form submit to the server.
    e.preventDefault();
    setProblem(null);

    const file = (f.elements.namedItem("file") as HTMLInputElement).files?.[0];
    const provider = (f.elements.namedItem("provider_id") as HTMLSelectElement).value;
    if (!file) return setProblem("Choose the file to upload.");
    if (file.size > MAX_BYTES) return setProblem("The file is larger than 20 MB.");

    setState("uploading");
    area?.start({ scope: "panel", label: "Uploading the price sheet...", leave: null }, f, (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null);
    const started = await priceSheetUploadUrl(provider, file.name);
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

    path.value = started.file_path;
    (f.elements.namedItem("file_name") as HTMLInputElement).value = file.name;
    setState("saving");
    form.current?.requestSubmit();
  }

  return (
    <form ref={form} action={createPriceSheet} onSubmit={onSubmit} className="ad-editor-fields">
      <Working />
      <input type="hidden" name="file_path" defaultValue="" />
      <input type="hidden" name="file_name" defaultValue="" />
      <label className="ad-field">
        <span>Provider</span>
        <select name="provider_id" defaultValue={chosen} required>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="ad-field">
        <span>Name</span>
        <input name="name" placeholder="BRP 2026 rates" required />
      </label>
      <label className="ad-field">
        <span>Takes effect</span>
        <input type="date" name="effective_from" required />
      </label>
      <label className="ad-field">
        <span>Ends (blank until replaced)</span>
        <input type="date" name="effective_to" />
      </label>
      <label className="ad-field ad-field--wide">
        <span>File: PDF, Excel (XLSX or XLS) or CSV, up to 20 MB</span>
        <input type="file" name="file" accept=".pdf,.xlsx,.xls,.csv" required />
      </label>
      {problem ? <p className="ad-badge ad-badge--warn ad-field--wide" role="alert">{problem}</p> : null}
      <div className="ad-editor-actions ad-field--wide">
        <button type="submit" className="ad-btn ad-btn--primary" disabled={state !== "idle"} aria-busy={state !== "idle" || undefined}>
          {state !== "idle" ? <span className="btn-spinner" aria-hidden="true" /> : null}
          {state === "uploading" ? "Uploading…" : state === "saving" ? "Saving…" : "Upload and read"}
        </button>
        <p className="ad-help">
          Claude reads the sheet into rates for you to review. Nothing is offered until a person publishes it.
        </p>
      </div>
    </form>
  );
}
