// _shared/price-sheet-extract.ts
//
// What Claude is asked, in what shape it answers, and how the answer becomes
// fni.price_sheet_rates rows. See docs/multi-provider.md, section 6.
//
// Pure, so a Node test can check the schema, the chunking and the mapping
// without calling the API. The call itself is in _shared/anthropic-price-sheet.ts.

import { CATEGORIES, type Category } from "./providers.ts";
import { RATEABLE_VTYPES } from "./vehicle-types.ts";
import type { CheckedRate } from "./price-sheet-checks.ts";

const nullable = (type: "string" | "integer" | "number") => ({ anyOf: [{ type }, { type: "null" }] });
const list = { type: "array", items: { type: "string" } };

/**
 * The structured output Claude must produce. Every field is required and every
 * object closed, which structured outputs require; "not stated" is a null or an
 * empty list, never a guess.
 */
export const RATES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rates", "notes"],
  properties: {
    notes: {
      type: "string",
      description: "Anything about the sheet as a whole a reviewer should know. Empty when nothing.",
    },
    rates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "product_code", "product_name", "family_code", "plan", "category",
          "makes", "model_contains", "year_min", "year_max", "vehicle_types",
          "conditions", "max_age_years", "max_odometer", "engine_cc_min",
          "engine_cc_max", "max_months_in_service", "term_months", "term_miles",
          "deductible", "dealer_cost", "suggested_retail", "options",
          "source_ref", "confidence", "note",
        ],
        properties: {
          product_code: { type: "string" },
          product_name: { type: "string" },
          family_code: nullable("string"),
          plan: nullable("string"),
          category: { anyOf: [{ type: "string", enum: [...CATEGORIES] }, { type: "null" }] },
          makes: list,
          model_contains: list,
          year_min: nullable("integer"),
          year_max: nullable("integer"),
          vehicle_types: { type: "array", items: { type: "string", enum: [...RATEABLE_VTYPES] } },
          conditions: { type: "array", items: { type: "string", enum: ["New", "Used"] } },
          max_age_years: nullable("integer"),
          max_odometer: nullable("integer"),
          engine_cc_min: nullable("integer"),
          engine_cc_max: nullable("integer"),
          max_months_in_service: nullable("integer"),
          term_months: nullable("integer"),
          term_miles: nullable("integer"),
          deductible: nullable("number"),
          dealer_cost: nullable("number"),
          suggested_retail: nullable("number"),
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["code", "label", "cost_delta", "mandatory"],
              properties: {
                code: { type: "string" },
                label: { type: "string" },
                cost_delta: { type: "number" },
                mandatory: { type: "boolean" },
              },
            },
          },
          source_ref: { type: "string" },
          confidence: { type: "string", enum: ["High", "Medium", "Low"] },
          note: nullable("string"),
        },
      },
    },
  },
} as const;

/** The instructions, the same for every chunk, so they cache. */
export function systemPrompt(providerName: string, providerMakes: string[]): string {
  return [
    `You read F&I price sheets for powersports and RV dealers. This sheet is from ${providerName}` +
      (providerMakes.length > 0 ? `, whose program covers ${providerMakes.join(", ")}.` : "."),
    "",
    "Return one rate for every buyable combination the sheet prices: each product, term, deductible",
    "and eligibility band that has its own dealer cost. Read only what the sheet says.",
    "",
    "Rules:",
    "- Never guess. When the sheet does not state a value, use null or an empty list.",
    "- dealer_cost is what the dealer pays. suggested_retail is a retail or MSRP figure the sheet",
    "  states, otherwise null. Money is in dollars, as numbers, with no symbols.",
    "- term_months is the coverage length in months (3 years is 36). term_miles is null unless stated.",
    "- makes are brand names as printed (Can-Am, Sea-Doo). Leave empty when the sheet does not",
    "  limit makes; the provider's program decides then.",
    "- vehicle_types uses these codes only: " + RATEABLE_VTYPES.join(", ") + ".",
    "- conditions is New, Used, both, or empty when not stated.",
    "- family_code groups tiers that are one decision for the customer (Gold, Silver and Bronze of",
    "  one plan share a family_code). plan is the tier or coverage level as printed.",
    "- category is one of: " + CATEGORIES.join(", ") + ".",
    "- source_ref says where the rate is: \"page 3, row 12\" or \"tab Rates, row 40\".",
    "- confidence is High when the value is printed plainly, Medium when it needed reading across a",
    "  table, and Low when you are unsure. Put what you were unsure of in note.",
    "- Surcharges and options with their own cost go in options, with mandatory true only when the",
    "  sheet says they always apply.",
    "Write notes and note in plain English.",
  ].join("\n");
}

/** One piece of a sheet sent in one request. */
export interface SheetChunk {
  /** "pages 1 to 10", "tab Rates, rows 1 to 250". */
  label: string;
  kind: "pdf" | "text";
  /** Base64 PDF bytes for kind pdf; CSV text for kind text. */
  data: string;
}

/**
 * CSV text in chunks of at most `rows` data rows, the header repeated on each,
 * so every chunk can be read on its own and nothing is truncated.
 */
export function csvChunks(csv: string, tab: string | null, rows = 250): SheetChunk[] {
  const lines = csv.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.replace(/,/g, "").trim() !== "");
  if (lines.length === 0) return [];
  const [header, ...body] = lines;
  const where = tab ? `tab ${tab}, ` : "";
  if (body.length === 0) return [{ label: `${where}header only`, kind: "text", data: header }];
  const out: SheetChunk[] = [];
  for (let i = 0; i < body.length; i += rows) {
    const part = body.slice(i, i + rows);
    out.push({
      label: `${where}rows ${i + 1} to ${i + part.length}`,
      kind: "text",
      data: [header, ...part].join("\n"),
    });
  }
  return out;
}

/** The model's output for one rate, as the schema describes it. */
export interface ExtractedRate {
  product_code: string;
  product_name: string;
  family_code: string | null;
  plan: string | null;
  category: string | null;
  makes: string[];
  model_contains: string[];
  year_min: number | null;
  year_max: number | null;
  vehicle_types: string[];
  conditions: string[];
  max_age_years: number | null;
  max_odometer: number | null;
  engine_cc_min: number | null;
  engine_cc_max: number | null;
  max_months_in_service: number | null;
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  dealer_cost: number | null;
  suggested_retail: number | null;
  options: { code: string; label: string; cost_delta: number; mandatory: boolean }[];
  source_ref: string;
  confidence: string;
  note: string | null;
}

/** A row ready for fni.price_sheet_rates, before the checks. */
export interface DraftRate extends CheckedRate {
  sheet_id: string;
  family_code: string | null;
  plan: string | null;
  category: Category | null;
  max_age_years: number | null;
  max_odometer: number | null;
  max_months_in_service: number | null;
  options: { code: string; label: string; cost_delta: number; mandatory: boolean; applied: boolean }[];
  source_ref: string;
}

const cents = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const whole = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.round(n));
const clean = (l: string[]) => [...new Set(l.map((s) => s.trim()).filter((s) => s !== ""))];

/**
 * The model's rates as rows. Money to the cent, counts to whole numbers, words
 * trimmed. A rate that names no make takes the provider's makes, because an OEM
 * program's sheet is about its own brands. Source labels are prefixed with the
 * chunk they came from when the model gave none.
 */
export function toDraftRates(
  sheetId: string,
  extracted: ExtractedRate[],
  providerMakes: string[],
  chunkLabel: string
): DraftRate[] {
  return extracted.map((e) => {
    const makes = clean(e.makes);
    const category = CATEGORIES.includes(e.category as Category) ? (e.category as Category) : null;
    const confidence = (["High", "Medium", "Low"].includes(e.confidence) ? e.confidence : "Low") as
      "High" | "Medium" | "Low";
    return {
      sheet_id: sheetId,
      product_code: e.product_code.trim(),
      product_name: e.product_name.trim(),
      family_code: e.family_code?.trim() || null,
      plan: e.plan?.trim() || null,
      category,
      makes: makes.length > 0 ? makes : [...providerMakes],
      model_contains: clean(e.model_contains),
      year_min: whole(e.year_min),
      year_max: whole(e.year_max),
      vehicle_types: clean(e.vehicle_types).map((v) => v.toUpperCase()),
      conditions: clean(e.conditions).filter((c) => c === "New" || c === "Used"),
      max_age_years: whole(e.max_age_years),
      max_odometer: whole(e.max_odometer),
      engine_cc_min: whole(e.engine_cc_min),
      engine_cc_max: whole(e.engine_cc_max),
      max_months_in_service: whole(e.max_months_in_service),
      term_months: whole(e.term_months),
      term_miles: whole(e.term_miles),
      deductible: cents(e.deductible),
      dealer_cost: cents(e.dealer_cost),
      suggested_retail: cents(e.suggested_retail),
      options: (e.options ?? []).map((o) => ({
        code: o.code.trim(),
        label: o.label.trim(),
        cost_delta: cents(o.cost_delta) ?? 0,
        mandatory: o.mandatory === true,
        applied: false,
      })),
      source_ref: e.source_ref?.trim() ? e.source_ref.trim() : chunkLabel,
      confidence,
      model_note: e.note?.trim() || null,
      flagged: false,
      flag_reason: null,
    };
  });
}
