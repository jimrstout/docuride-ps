// _shared/zoho-files.ts
//
// Uploading a generated document to a Zoho CRM file-upload field.
//
// New file rather than an edit to _shared/zoho.ts, which is bundled into
// zoho-sync, zoho-backfill and rr-report. It borrows that module's token
// handling by import, so nothing those functions depend on changes.

import { accessToken } from "./zoho.ts";

const API = Deno.env.get("ZOHO_API_DOMAIN") ?? "https://www.zohoapis.com";

export interface UploadedFile {
  file_id: string;
}

/**
 * Upload bytes to Zoho's file store and get back the id a file-upload field
 * refers to. This does NOT attach it to anything; attachToField does that.
 */
export async function uploadFile(
  filename: string,
  bytes: Uint8Array,
  contentType = "application/pdf"
): Promise<UploadedFile> {
  const token = await accessToken();

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), filename);

  const res = await fetch(`${API}/crm/v8/files`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Zoho file upload ${res.status}: ${text}`);

  const parsed = JSON.parse(text) as {
    data?: { code?: string; Code?: string; details?: { id?: string }; message?: string }[];
  };
  const row = parsed.data?.[0];
  const id = row?.details?.id;
  const code = row?.code ?? row?.Code;

  if (!id || (code && code !== "SUCCESS")) {
    throw new Error(`Zoho file upload rejected: ${text}`);
  }
  return { file_id: id };
}

/**
 * Patch fields on a record. Used for both the file-upload field and the
 * signature map, in one call, so a half-written record is not possible.
 */
export async function updateRecordFields(
  module: string,
  recordId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const token = await accessToken();

  const res = await fetch(`${API}/crm/v8/${module}/${encodeURIComponent(recordId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [fields] }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Zoho update ${module}/${recordId} ${res.status}: ${text}`);

  const parsed = JSON.parse(text) as { data?: { code?: string; Code?: string; message?: string }[] };
  const row = parsed.data?.[0];
  const code = row?.code ?? row?.Code;
  if (code && code !== "SUCCESS") {
    throw new Error(`Zoho update rejected: ${text}`);
  }
}

/** The value shape a Zoho file-upload field expects. */
export function fileUploadValue(fileId: string): { file_id: string }[] {
  return [{ file_id: fileId }];
}
