// _shared/price-sheet-parse.ts
//
// Reading an uploaded price sheet into Draft rates. See docs/multi-provider.md,
// section 6.
//
//   1. The file comes out of the private price-sheets bucket.
//   2. A PDF is sent ten pages at a time as document blocks. A spreadsheet is
//      sent as CSV, one tab at a time, 250 rows at a time with the header on
//      each. A piece too dense for one answer is halved and read again.
//   3. Each piece's rates become rows; the server checks flag what looks
//      wrong; the rows are stored against the sheet.
//   4. The sheet records the model, the tokens and how long it took, and stays
//      a Draft. Publishing is a person's decision.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import * as XLSX from "npm:xlsx@0.18.5";
import { csvChunks, systemPrompt, toDraftRates, type DraftRate, type SheetChunk } from "./price-sheet-extract.ts";
import { checkRates } from "./price-sheet-checks.ts";
import { claudeReader, readChunk, ReadError, type ClaudeReader } from "./anthropic-price-sheet.ts";
import { BUCKET } from "./price-sheet-admin.ts";

const PDF_PAGES_PER_CHUNK = 10;

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** The file as pieces Claude can read one at a time. */
export async function fileChunks(bytes: Uint8Array, fileType: string): Promise<SheetChunk[]> {
  if (fileType === "PDF") {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = doc.getPageCount();
    const out: SheetChunk[] = [];
    for (let start = 0; start < pages; start += PDF_PAGES_PER_CHUNK) {
      const end = Math.min(start + PDF_PAGES_PER_CHUNK, pages);
      const part = await PDFDocument.create();
      const copied = await part.copyPages(doc, Array.from({ length: end - start }, (_, i) => start + i));
      copied.forEach((p) => part.addPage(p));
      out.push({
        label: end - start === 1 ? `page ${start + 1}` : `pages ${start + 1} to ${end}`,
        kind: "pdf",
        data: base64(await part.save()),
      });
    }
    return out;
  }
  if (fileType === "CSV") return csvChunks(new TextDecoder().decode(bytes), null);

  const book = XLSX.read(bytes, { type: "array" });
  return book.SheetNames.flatMap((tab: string) =>
    csvChunks(XLSX.utils.sheet_to_csv(book.Sheets[tab], { blankrows: false }), tab)
  );
}

/** Halve a CSV piece by its rows, the header kept on both halves. */
function halve(chunk: SheetChunk): SheetChunk[] | null {
  if (chunk.kind !== "text") return null;
  const [header, ...rows] = chunk.data.split("\n");
  if (rows.length < 20) return null;
  const mid = Math.ceil(rows.length / 2);
  return [
    { kind: "text", label: `${chunk.label}, first half`, data: [header, ...rows.slice(0, mid)].join("\n") },
    { kind: "text", label: `${chunk.label}, second half`, data: [header, ...rows.slice(mid)].join("\n") },
  ];
}

interface Totals {
  rows: DraftRate[];
  notes: string[];
  inputTokens: number;
  outputTokens: number;
  servedBy: Set<string>;
}

async function readInto(
  reader: ClaudeReader,
  system: string,
  chunk: SheetChunk,
  sheetId: string,
  makes: string[],
  totals: Totals,
  depth = 0
): Promise<void> {
  try {
    const r = await readChunk(reader, system, chunk);
    totals.rows.push(...toDraftRates(sheetId, r.rates, makes, chunk.label));
    if (r.notes) totals.notes.push(`${chunk.label}: ${r.notes}`);
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.servedBy.add(r.servedBy);
  } catch (err) {
    const halves = err instanceof ReadError && depth < 3 ? halve(chunk) : null;
    if (!halves) throw err;
    for (const h of halves) await readInto(reader, system, h, sheetId, makes, totals, depth + 1);
  }
}

async function setSheet(supabase: SupabaseClient, sheetId: string, patch: Record<string, unknown>) {
  const { error } = await supabase
    .schema("fni")
    .from("price_sheets")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", sheetId);
  if (error) console.error(`PRICE_SHEET_UPDATE_FAILED sheet=${sheetId}: ${error.message}`);
}

/**
 * Read a sheet into Draft rates. Never throws: the outcome is written to the
 * sheet as Parsed or Parse Failed, with notes a person can read.
 */
export async function parseSheet(supabase: SupabaseClient, sheetId: string): Promise<void> {
  const started = Date.now();
  try {
    const { data: sheet, error } = await supabase
      .schema("fni")
      .from("price_sheets")
      .select("id, file_path, file_type, provider:providers!inner(name, makes)")
      .eq("id", sheetId)
      .single();
    if (error || !sheet) throw new Error(`The sheet could not be read back: ${error?.message ?? "not found"}`);
    const s = sheet as unknown as {
      file_path: string;
      file_type: string;
      provider: { name: string; makes: string[] };
    };

    const reader = claudeReader();

    const { data: file, error: fileErr } = await supabase.storage.from(BUCKET).download(s.file_path);
    if (fileErr || !file) throw new Error(`The uploaded file could not be opened: ${fileErr?.message ?? "missing"}`);
    const chunks = await fileChunks(new Uint8Array(await file.arrayBuffer()), s.file_type);
    if (chunks.length === 0) throw new Error("The file has no pages or rows to read.");

    const system = systemPrompt(s.provider.name, s.provider.makes ?? []);
    const totals: Totals = { rows: [], notes: [], inputTokens: 0, outputTokens: 0, servedBy: new Set() };
    for (const chunk of chunks) {
      await readInto(reader, system, chunk, sheetId, s.provider.makes ?? [], totals);
    }

    const checked = checkRates(totals.rows);
    for (let i = 0; i < checked.length; i += 500) {
      const { error: insErr } = await supabase
        .schema("fni")
        .from("price_sheet_rates")
        .insert(checked.slice(i, i + 500));
      if (insErr) throw new Error(`The rates could not be saved: ${insErr.message}`);
    }

    const flagged = checked.filter((r) => r.flagged).length;
    const summary =
      `Read ${checked.length} ${checked.length === 1 ? "rate" : "rates"} from ` +
      `${chunks.length} ${chunks.length === 1 ? "piece" : "pieces"}. ` +
      (flagged === 0 ? "None are flagged." : `${flagged} ${flagged === 1 ? "is" : "are"} flagged for review.`);

    await setSheet(supabase, sheetId, {
      parse_status: "Parsed",
      parse_notes: [summary, ...totals.notes].join("\n"),
      model: [...totals.servedBy].join(", "),
      input_tokens: totals.inputTokens,
      output_tokens: totals.outputTokens,
      parse_seconds: Math.round((Date.now() - started) / 100) / 10,
      parsed_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`PRICE_SHEET_PARSE_FAILED sheet=${sheetId}: ${message}`);
    await setSheet(supabase, sheetId, {
      parse_status: "Parse Failed",
      parse_notes: message,
      parse_seconds: Math.round((Date.now() - started) / 100) / 10,
    });
  }
}
