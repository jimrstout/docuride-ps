// _shared/pdf-pages.ts
//
// A PDF's page count and each page's size in points, as pdf-lib reads them.
// pdf-lib is passed in, so a Node test can hold the shape with a stand-in.

export interface PageSize {
  page: number;
  width: number;
  height: number;
  rotation: number;
}

/** The slice of a loaded pdf-lib document this needs. */
export interface PagedDocument {
  getPages(): { getSize(): { width: number; height: number }; getRotation(): { angle: number } }[];
}

export function pageSizes(doc: PagedDocument): { page_count: number; page_sizes: PageSize[] } {
  const pages = doc.getPages();
  return {
    page_count: pages.length,
    page_sizes: pages.map((p, i) => {
      const { width, height } = p.getSize();
      return { page: i + 1, width, height, rotation: p.getRotation().angle };
    }),
  };
}

/** Base64 to bytes. */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Real PDF content: non-empty and starting with %PDF, as DocuRide DC checks. */
export function isPdf(bytes: Uint8Array | null): boolean {
  return !!bytes && bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/** What the provider returned, without the PDF itself, otherwise exactly as returned. */
export function withoutPdf(doc: Record<string, unknown>): Record<string, unknown> {
  const { data: _pdf, ...rest } = doc;
  return rest;
}
