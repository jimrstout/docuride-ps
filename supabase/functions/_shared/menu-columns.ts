// _shared/menu-columns.ts
//
// The conventional menu's package columns, per menu template (migration
// 0042, fni.menu_template_columns). A template has two to five columns, each
// with a name, its order, the product categories it starts checked, and the
// coverage level its products start at.
//
// A template with no columns saved uses DEFAULT_COLUMNS, so a new template
// works before anyone edits it. Presets are by category because the exact
// product depends on what rates for the deal; a preset category with no rated
// product on a deal is simply absent from that column.
//
// Coverage level picks a tier within a product's levels, cheapest first
// (levelIndex): Lowest is the cheapest, Highest the most expensive, Middle the
// one in the middle, the lower of the two when the count is even.
//
// Pure, so a Node test can hold it.

import { CATEGORIES, type Category } from "./providers.ts";

export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 5;

export const LEVELS = ["Lowest", "Middle", "Highest"] as const;
export type Level = (typeof LEVELS)[number];

export interface MenuColumn {
  name: string;
  preset_categories: Category[];
  starting_level: Level;
}

/** The layout a template uses until someone saves its own. */
export const DEFAULT_COLUMNS: readonly MenuColumn[] = [
  {
    name: "Platinum",
    preset_categories: ["Mechanical Protection", "Maintenance", "Tire and Wheel", "Theft", "Battery", "Appearance"],
    starting_level: "Highest",
  },
  {
    name: "Gold",
    preset_categories: ["Mechanical Protection", "Tire and Wheel", "Theft", "Battery"],
    starting_level: "Middle",
  },
  { name: "Silver", preset_categories: ["Mechanical Protection", "Tire and Wheel"], starting_level: "Lowest" },
  { name: "Basic", preset_categories: ["Mechanical Protection"], starting_level: "Lowest" },
];

export function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

/** Which tier a level picks, of `count` tiers in cheapest-first order. */
export function levelIndex(level: Level, count: number): number {
  if (count <= 1) return 0;
  if (level === "Lowest") return 0;
  if (level === "Highest") return count - 1;
  return Math.floor((count - 1) / 2);
}

/** A template's columns as saved, or the default layout when it has none. */
export function columnsFor(
  rows: { position: number; name: string; preset_categories: string[] | null; starting_level: string | null }[]
): { columns: MenuColumn[]; is_default: boolean } {
  if (rows.length < MIN_COLUMNS) return { columns: DEFAULT_COLUMNS.map((c) => ({ ...c, preset_categories: [...c.preset_categories] })), is_default: true };
  return {
    columns: [...rows]
      .sort((a, b) => a.position - b.position)
      .map((r) => ({
        name: r.name,
        preset_categories: (r.preset_categories ?? []).filter((c): c is Category => (CATEGORIES as readonly string[]).includes(c)),
        starting_level: isLevel(r.starting_level) ? r.starting_level : "Lowest",
      })),
    is_default: false,
  };
}

/**
 * Columns as an administrator sent them, checked. Every refusal is a sentence.
 * A column with a blank name is one not in use, so a form can always offer
 * five rows.
 */
export function parseColumns(raw: unknown): { columns: MenuColumn[] } | { errors: string[] } {
  if (!Array.isArray(raw)) return { errors: ["The columns are missing."] };
  const errors: string[] = [];
  const columns: MenuColumn[] = [];
  for (const [i, c] of (raw as Record<string, unknown>[]).entries()) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (name === "") continue;
    if (name.length > 40) errors.push(`Column ${i + 1}'s name is longer than 40 characters.`);
    const cats = Array.isArray(c.preset_categories) ? (c.preset_categories as unknown[]).map(String) : [];
    const unknown = cats.filter((x) => !(CATEGORIES as readonly string[]).includes(x));
    if (unknown.length > 0) errors.push(`${name} names a category that does not exist: ${unknown.join(", ")}.`);
    const level = c.starting_level === undefined || c.starting_level === "" ? "Lowest" : c.starting_level;
    if (!isLevel(level)) errors.push(`${name}'s starting coverage level must be Lowest, Middle or Highest.`);
    columns.push({
      name,
      preset_categories: [...new Set(cats.filter((x): x is Category => (CATEGORIES as readonly string[]).includes(x)))],
      starting_level: isLevel(level) ? level : "Lowest",
    });
  }
  if (columns.length < MIN_COLUMNS || columns.length > MAX_COLUMNS) {
    errors.push(`A menu has two to five columns. This one has ${columns.length}.`);
  }
  const names = columns.map((c) => c.name.toLowerCase());
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length > 0) errors.push(`Two columns cannot share a name: ${[...new Set(twice)].join(", ")}.`);
  return errors.length > 0 ? { errors } : { columns };
}
