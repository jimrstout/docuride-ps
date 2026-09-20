// Pull the visible strings back out of a finished PDF.
//
// pdf-lib saves with object streams and Flate compression and writes text as
// hex strings, so this inflates every stream and decodes the text-showing
// operators. Assertions therefore run against the bytes that actually ship,
// not against a special uncompressed build of them.

import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";

export async function pdfText(bytes) {
  const doc = await PDFDocument.load(bytes);
  const buf = Buffer.from(bytes);

  let streams = "";
  let i = 0;
  for (;;) {
    const start = buf.indexOf("stream", i);
    if (start === -1) break;
    let from = start + 6;
    if (buf[from] === 0x0d) from++;
    if (buf[from] === 0x0a) from++;
    const end = buf.indexOf("endstream", from);
    if (end === -1) break;
    const chunk = buf.subarray(from, end);
    try {
      streams += inflateSync(chunk).toString("latin1");
    } catch {
      streams += chunk.toString("latin1");
    }
    i = end + 9;
  }

  const parts = [];

  // pdf-lib writes text as hex strings: <414C4C...> Tj
  for (const m of streams.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
    parts.push(Buffer.from(m[1].replace(/\s+/g, ""), "hex").toString("latin1"));
  }
  // and literal strings, should a future version change its mind
  for (const m of streams.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    parts.push(m[1].replace(/\\([()\\])/g, "$1"));
  }

  return { pages: doc.getPageCount(), raw: parts.join("\n"), streams };
}
