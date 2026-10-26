// _shared/workdrive.ts
//
// The four WorkDrive calls PS makes, through DocuRide DC's Zoho client
// (_shared/dc-zoho.ts): list a folder, move a file to the trash, upload a
// file, rename a file. The same endpoints and headers DC uses for its own
// documents in the same Deal Jackets.
//
// Privacy: file names carry buyer names, so nothing here logs a name or a
// response body. A failure keeps WorkDrive's status and error code only.

import { dcFetch } from "./dc-zoho.ts";

const WORKDRIVE_API = "https://www.zohoapis.com/workdrive/api/v1";

/** A WorkDrive call that failed: status and WorkDrive's error code only. */
export class WorkDriveError extends Error {
  status: number;
  code: string | null;
  constructor(op: string, status: number, code: string | null) {
    super(`WorkDrive ${op} failed (${status}${code ? `, ${code}` : ""})`);
    this.status = status;
    this.code = code;
  }
}

async function errorCode(r: Response): Promise<string | null> {
  try {
    const j = (await r.json()) as { errors?: { id?: unknown }[]; code?: unknown };
    const id = j.errors?.[0]?.id ?? j.code;
    return id === undefined || id === null ? null : String(id).slice(0, 40);
  } catch {
    return null;
  }
}

/** Every item in a folder, id and name. */
export async function listFolderItems(folderId: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  for (let page = 0; page < 40; page++) {
    const q = `page%5Blimit%5D=50&page%5Boffset%5D=${page * 50}`;
    const r = await dcFetch(`${WORKDRIVE_API}/files/${encodeURIComponent(folderId)}/files?${q}`, {
      headers: { Accept: "application/vnd.api+json" },
    });
    if (!r.ok) throw new WorkDriveError("list", r.status, await errorCode(r));
    const j = (await r.json()) as { data?: { id?: unknown; attributes?: { name?: unknown } }[] };
    const rows = j.data ?? [];
    for (const f of rows) if (f.id) out.push({ id: String(f.id), name: String(f.attributes?.name ?? "") });
    if (rows.length < 50) break;
  }
  return out;
}

/** Move a file to the WorkDrive trash (status 51), as DocuRide DC replaces its own. */
export async function trashFile(fileId: string): Promise<void> {
  const r = await dcFetch(`${WORKDRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: "PATCH",
    headers: { Accept: "application/vnd.api+json", "Content-Type": "application/json" },
    body: JSON.stringify({ data: { attributes: { status: "51" }, type: "files" } }),
  });
  if (!r.ok) throw new WorkDriveError("trash", r.status, await errorCode(r));
}

/** Upload a PDF into a folder under this name. Returns the new file's id. */
export async function uploadPdf(folderId: string, fileName: string, bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("filename", fileName);
  form.append("parent_id", folderId);
  form.append("override-name-exist", "true");
  form.append("content", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), fileName);
  const r = await dcFetch(`${WORKDRIVE_API}/upload`, { method: "POST", body: form });
  if (!r.ok) throw new WorkDriveError("upload", r.status, await errorCode(r));
  const j = (await r.json().catch(() => ({}))) as { data?: { attributes?: { resource_id?: unknown } }[] };
  const id = j.data?.[0]?.attributes?.resource_id;
  if (!id) throw new WorkDriveError("upload", r.status, "no_id");
  return String(id);
}

/** Rename a file in place. Nothing is moved or deleted. */
export async function renameFile(fileId: string, name: string): Promise<void> {
  const r = await dcFetch(`${WORKDRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: "PATCH",
    headers: { Accept: "application/vnd.api+json", "Content-Type": "application/json" },
    body: JSON.stringify({ data: { attributes: { name }, type: "files" } }),
  });
  if (!r.ok) throw new WorkDriveError("rename", r.status, await errorCode(r));
}

/**
 * What to tell staff when WorkDrive refuses, in plain English. A refusal for
 * a missing permission names the scope the Document Center's Zoho login needs.
 */
export function workDriveProblem(err: unknown): string {
  if ((err as { code?: unknown })?.code === "Zoho Sign-In Failed") {
    return "The Document Center's Zoho login was refused, so nothing was saved to WorkDrive. Ask an administrator to check it.";
  }
  if (err instanceof WorkDriveError) {
    if (err.status === 401 || err.status === 403 || /scope/i.test(err.code ?? "")) {
      return (
        `WorkDrive refused the Document Center's Zoho login (${err.code ?? err.status}). It needs the ` +
        `WorkDrive.files.ALL scope and access to the DocuRide Sale Documents team folder.`
      );
    }
    return `WorkDrive did not save the document (${err.code ?? err.status}). Try again shortly.`;
  }
  return "The document could not be saved to WorkDrive. Try again shortly.";
}

/** The link staff open in WorkDrive. */
export function workDriveFileUrl(fileId: string): string {
  return `https://workdrive.zoho.com/file/${encodeURIComponent(fileId)}`;
}
