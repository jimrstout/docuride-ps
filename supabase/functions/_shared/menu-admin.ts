// _shared/menu-admin.ts
//
// Checking what staff send from the admin area's Providers and Menus sections.
// Pure, so a Node test can hold the rules, and every refusal is a sentence.
//
// Stored values are the words people read: "Price Sheet", "Recorded by Staff",
// "Loan", "Cash", "New", "Used", "Best Match", "Side by Side".

import { CATEGORIES } from "./providers.ts";
import { VEHICLE_TYPES } from "./vehicle-types.ts";
import { SLOT_MODES } from "./menu-templates.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

/** A list from an array, or from comma-separated text the way a person types it. */
export function listOf(v: unknown): string[] {
  const items = Array.isArray(v) ? v.map(String) : text(v).split(",");
  return [...new Set(items.map((s) => s.trim()).filter((s) => s !== ""))];
}

const bool = (v: unknown) => v === true || v === "on" || v === "true";

// ── Providers ────────────────────────────────────────────────────────────

export interface ProviderFields {
  name: string;
  makes: string[];
  active: boolean;
  notes: string | null;
  /** Starts the WorkDrive name of its documents ("TA"). Null when not set. */
  document_prefix: string | null;
}

/**
 * A provider's editable fields. Kind, adapter and contract method are not
 * edited here: changing how a provider is rated is a code change, not a form.
 * A new provider from the admin area is always a Price Sheet provider whose
 * contracts are recorded by staff.
 */
export function parseProvider(body: Record<string, unknown>): { fields: ProviderFields } | { errors: string[] } {
  const errors: string[] = [];
  const name = text(body.name);
  if (name === "") errors.push("Give the provider a name.");
  if (name.length > 80) errors.push("That name is longer than 80 characters.");
  const notes = text(body.notes);
  if (notes.length > 1000) errors.push("The notes are longer than 1,000 characters.");
  const prefix = text(body.document_prefix).toUpperCase();
  if (prefix !== "" && !/^[A-Z0-9]{2,6}$/.test(prefix)) {
    errors.push("The document prefix is two to six letters or digits, such as TA.");
  }
  if (errors.length > 0) return { errors };
  return {
    fields: {
      name,
      makes: listOf(body.makes),
      active: bool(body.active),
      notes: notes === "" ? null : notes,
      document_prefix: prefix === "" ? null : prefix,
    },
  };
}

/** The stores a Price Sheet provider is sold at, checked against the real ones. */
export function parseStoreIds(v: unknown, known: string[]): { ids: string[] } | { errors: string[] } {
  const ids = listOf(v);
  const bad = ids.filter((id) => !UUID.test(id) || !known.includes(id));
  return bad.length > 0 ? { errors: ["One of those stores does not exist."] } : { ids };
}

// ── Templates ────────────────────────────────────────────────────────────

export interface TemplateFields {
  name: string;
  description: string | null;
  store_ids: string[];
  deal_types: string[];
  vehicle_types: string[];
  conditions: string[];
  makes: string[];
  priority: number;
  active: boolean;
}

export function parseTemplate(
  body: Record<string, unknown>,
  knownStores: string[]
): { fields: TemplateFields } | { errors: string[] } {
  const errors: string[] = [];
  const name = text(body.name);
  if (name === "") errors.push("Give the menu a name, such as \"New Can-Am\".");
  if (name.length > 80) errors.push("That name is longer than 80 characters.");

  const stores = parseStoreIds(body.store_ids, knownStores);
  if ("errors" in stores) errors.push(...stores.errors);

  const dealTypes = listOf(body.deal_types);
  if (dealTypes.some((d) => d !== "Loan" && d !== "Cash")) errors.push("Deal types are Loan and Cash.");
  const conditions = listOf(body.conditions);
  if (conditions.some((c) => c !== "New" && c !== "Used")) errors.push("New or Used must be New, Used, or both.");
  // Verify's choices, as shown: "On-Road Motorcycle". Typed in any case.
  const typed = listOf(body.vehicle_types);
  const vehicleTypes = typed.map((v) => VEHICLE_TYPES.find((t) => t.toLowerCase() === v.toLowerCase()) ?? v);
  if (vehicleTypes.some((v) => !(VEHICLE_TYPES as readonly string[]).includes(v))) {
    errors.push(`Vehicle types must be from: ${VEHICLE_TYPES.join(", ")}.`);
  }

  const p = text(body.priority);
  const priority = p === "" ? 0 : Number(p);
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
    errors.push("Priority is a whole number from 0 to 1,000.");
  }

  if (errors.length > 0 || "errors" in stores) return { errors };
  const description = text(body.description);
  return {
    fields: {
      name,
      description: description === "" ? null : description,
      store_ids: stores.ids,
      deal_types: dealTypes,
      vehicle_types: vehicleTypes,
      conditions,
      makes: listOf(body.makes),
      priority,
      active: bool(body.active),
    },
  };
}

export interface SlotFields {
  title: string;
  category: string | null;
  mode: string;
  product_ids: string[];
}

/**
 * A slot, checked. Its products are catalog ids in the order they are
 * preferred, and must be products the catalog has.
 */
export function parseSlot(
  body: Record<string, unknown>,
  knownProducts: string[]
): { fields: SlotFields } | { errors: string[] } {
  const errors: string[] = [];
  const title = text(body.title);
  if (title === "") errors.push("Give the slot a title, such as \"Mechanical Protection\".");
  const category = text(body.category);
  if (category !== "" && !(CATEGORIES as readonly string[]).includes(category)) {
    errors.push(`Category must be one of: ${CATEGORIES.join(", ")}.`);
  }
  const mode = text(body.mode) || "Side by Side";
  if (!(SLOT_MODES as readonly string[]).includes(mode)) errors.push("Show must be Best Match or Side by Side.");
  const productIds = listOf(body.product_ids);
  if (productIds.some((id) => !knownProducts.includes(id))) errors.push("One of those products is not in the catalog.");
  if (errors.length > 0) return { errors };
  return { fields: { title, category: category === "" ? null : category, mode, product_ids: productIds } };
}

/** A plain-English line for a template's conditions, for the list. */
export function conditionsLine(
  t: Pick<TemplateFields, "store_ids" | "deal_types" | "vehicle_types" | "conditions" | "makes">,
  storeName: (id: string) => string
): string {
  const parts: string[] = [];
  if (t.conditions.length > 0) parts.push(t.conditions.join(" or "));
  if (t.makes.length > 0) parts.push(t.makes.join(" or "));
  if (t.vehicle_types.length > 0) parts.push(t.vehicle_types.join(" or "));
  if (t.deal_types.length > 0) parts.push(`${t.deal_types.join(" or ")} deals`);
  if (t.store_ids.length > 0) parts.push(`at ${t.store_ids.map(storeName).join(", ")}`);
  return parts.length === 0 ? "Every deal" : parts.join(", ");
}

// ── Product wording ──────────────────────────────────────────────────────

export const GOALS = ["Keep ownership manageable", "Keep ownership enjoyable", "Keep the asset valuable"] as const;

/** The customer wording fields, in the order the planner asks its questions. */
export const WORDING_FIELDS = [
  "what_it_accomplishes",
  "what_it_covers",
  "coverage_duration",
  "what_it_excludes",
  "deductible_note",
  "how_to_use",
  "transfer_note",
  "future_value_note",
  "full_terms_url",
] as const;

/** What a product still needs before the planner will show it, in words. */
export function wordingMissing(row: Record<string, unknown>): string[] {
  const missing: string[] = [];
  const blank = (k: string) => text(row[k]) === "";
  if (blank("what_it_accomplishes")) missing.push("what it accomplishes");
  if (blank("what_it_covers")) missing.push("what it covers");
  if (blank("coverage_duration")) missing.push("how long it lasts");
  if (blank("what_it_excludes")) missing.push("what it excludes");
  if (blank("how_to_use")) missing.push("how to use it");
  if (row.transferable !== true && row.transferable !== false) missing.push("whether it transfers");
  if (blank("full_terms_url")) missing.push("a link to the full terms");
  if (row.active !== true) missing.push("to be switched on");
  return missing;
}

/**
 * A product's wording, as staff write it. Nothing here is generated: the words
 * a customer reads are written by a person, checked against the provider's
 * approved language.
 */
export function parseWording(body: Record<string, unknown>): { fields: Record<string, unknown> } | { errors: string[] } {
  const errors: string[] = [];
  const name = text(body.display_name);
  if (name === "") errors.push("Give the product the name customers see.");
  if (name.length > 120) errors.push("That name is longer than 120 characters.");
  const goal = text(body.goal);
  if (!(GOALS as readonly string[]).includes(goal)) errors.push("Choose which goal the product serves.");
  const transfer = text(body.transferable);
  if (!["", "Yes", "No"].includes(transfer)) errors.push("Transfers must be Yes, No, or not answered yet.");
  const fields: Record<string, unknown> = {
    display_name: name,
    goal,
    transferable: transfer === "" ? null : transfer === "Yes",
    active: bool(body.active),
  };
  for (const k of WORDING_FIELDS) {
    const v = text(body[k]);
    if (v.length > 2000) errors.push("One of the answers is longer than 2,000 characters.");
    fields[k] = v === "" ? null : v;
  }
  const url = fields.full_terms_url as string | null;
  if (url !== null && !/^https:\/\/\S+$/i.test(url)) errors.push("The full terms link must start with https://.");
  if (errors.length > 0) return { errors: [...new Set(errors)] };
  return { fields };
}
