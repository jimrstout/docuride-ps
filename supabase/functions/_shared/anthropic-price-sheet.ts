// _shared/anthropic-price-sheet.ts
//
// Reading one piece of a price sheet with Claude. See docs/multi-provider.md,
// section 6.
//
// Two secrets and no others: DOCURIDE_PS_ANTHROPIC_API_KEY, and the model in
// DOCURIDE_PS_ANTHROPIC_MODEL (claude-sonnet-5-5 when unset). There is no
// fallback to any other secret name. The key is handed to the client and to
// nothing else: it is never logged, stored or returned.
//
// The answer is constrained by structured outputs (output_config.format), not a
// forced tool: Sonnet 5.5 refuses forced tool use, and the JSON schema in
// _shared/price-sheet-extract.ts is the whole contract either way.

import Anthropic from "npm:@anthropic-ai/sdk";
import { RATES_SCHEMA, type ExtractedRate, type SheetChunk } from "./price-sheet-extract.ts";

export const KEY_SECRET = "DOCURIDE_PS_ANTHROPIC_API_KEY";
export const MODEL_SECRET = "DOCURIDE_PS_ANTHROPIC_MODEL";
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** Said when the key is not set. Names the secret, never shows a value. */
export const MISSING_KEY_MESSAGE =
  `The ${KEY_SECRET} secret is not set, so price sheets cannot be read. ` +
  `Add it under Edge Function secrets in the Supabase project, then read the sheet again.`;

export class MissingKeyError extends Error {
  constructor() {
    super(MISSING_KEY_MESSAGE);
  }
}

/** The models that accept the server-side refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export interface ClaudeReader {
  client: Anthropic;
  model: string;
}

/** The client and model from the two secrets. Throws MissingKeyError. */
export function claudeReader(): ClaudeReader {
  const key = Deno.env.get(KEY_SECRET);
  if (!key || key.trim() === "") throw new MissingKeyError();
  const model = Deno.env.get(MODEL_SECRET)?.trim() || DEFAULT_MODEL;
  return { client: new Anthropic({ apiKey: key.trim() }), model };
}

export interface ChunkResult {
  rates: ExtractedRate[];
  notes: string;
  inputTokens: number;
  outputTokens: number;
  /** The model that answered: a refusal fallback may have served it. */
  servedBy: string;
}

/** Raised when a piece of the sheet could not be read, in plain English. */
export class ReadError extends Error {}

/**
 * Read one piece of the sheet.
 *
 * Streamed, because a dense rate table is a long answer and a non-streaming
 * request that size can time out. The system prompt is marked for caching, so
 * every piece after the first reads it from the cache.
 */
export async function readChunk(reader: ClaudeReader, system: string, chunk: SheetChunk): Promise<ChunkResult> {
  const source =
    chunk.kind === "pdf"
      ? {
          type: "document" as const,
          source: { type: "base64" as const, media_type: "application/pdf" as const, data: chunk.data },
        }
      : { type: "text" as const, text: `The sheet's contents, ${chunk.label}, as CSV:\n\n${chunk.data}` };

  const params = {
    model: reader.model,
    max_tokens: 64000,
    system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
    output_config: { format: { type: "json_schema" as const, schema: RATES_SCHEMA } },
    messages: [
      {
        role: "user" as const,
        content: [source, { type: "text" as const, text: `Read every rate in ${chunk.label}.` }],
      },
    ],
  };

  const message = FALLBACK_MODELS.has(reader.model)
    ? await reader.client.beta.messages
        .stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as never)
        .finalMessage()
    : await reader.client.messages.stream(params as never).finalMessage();

  const m = message as unknown as {
    stop_reason: string | null;
    model: string;
    content: { type: string; text?: string }[];
    usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null };
  };

  if (m.stop_reason === "refusal") {
    throw new ReadError(`Claude declined to read ${chunk.label}. Check the file is a price sheet.`);
  }
  if (m.stop_reason === "max_tokens") {
    throw new ReadError(`${chunk.label} holds more rates than one reading can return.`);
  }

  const text = m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  let parsed: { rates?: ExtractedRate[]; notes?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReadError(`The reading of ${chunk.label} did not come back as rates.`);
  }

  return {
    rates: Array.isArray(parsed.rates) ? parsed.rates : [],
    notes: typeof parsed.notes === "string" ? parsed.notes.trim() : "",
    inputTokens: (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0),
    outputTokens: m.usage.output_tokens ?? 0,
    servedBy: m.model,
  };
}
