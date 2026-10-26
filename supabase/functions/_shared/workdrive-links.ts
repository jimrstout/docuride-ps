// _shared/workdrive-links.ts
//
// The link staff open for a WorkDrive file. Apart from _shared/workdrive.ts so
// a function that only shows links does not load the Zoho client.

export function workDriveFileUrl(fileId: string): string {
  return `https://workdrive.zoho.com/file/${encodeURIComponent(fileId)}`;
}
