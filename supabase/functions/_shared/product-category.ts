// _shared/product-category.ts: what kind of product an offer or contract is.
//
// The catalog (fni.product_catalog) says, product by product: "Priority
// Maintenance, Bronze" is Maintenance. But the provider gives each vehicle
// version of a plan its own product code (the Bronze plan is 62_7, 66_7,
// 1619_7 and, for a used ATV, 64_7), and the catalog does not list every one.
// On deal 15063 the four ATV codes were not in it, so the Priority Maintenance
// offers matched no menu row and silently vanished from Prepare presentation,
// and a contract for one would have been called "Product" by the DX1 check.
//
// The provider's own product type says the same thing for every version, so
// it decides when the catalog has no row:
//   PPM  Maintenance            THP  Theft
//   VSA  Mechanical Protection  BAT  Battery
//   TAW  Tire and Wheel
// and a contract, which keeps only the provider's name for the product, is
// read by the words in that name ("... - RIDERS ADVANTAGE PPM" is Maintenance).
//
// Pure, so a Node test holds it.

/** The provider's product type to our menu category. */
export const PROVIDER_TYPE_CATEGORY: Readonly<Record<string, string>> = {
  PPM: "Maintenance",
  VSA: "Mechanical Protection",
  TAW: "Tire and Wheel",
  THP: "Theft",
  BAT: "Battery",
};

/** "PPM" to "Maintenance". Null for a type this table does not know. */
export function categoryForType(ptype: unknown): string | null {
  if (typeof ptype !== "string") return null;
  return PROVIDER_TYPE_CATEGORY[ptype.trim().toUpperCase()] ?? null;
}

/** Words in the provider's name for a product that say what it is. */
const BY_WORDING: [RegExp, string][] = [
  [/\bppm\b|\bmaint(?:enance)?\b/i, "Maintenance"],
  [/\bcare\b|\bvsa\b/i, "Mechanical Protection"],
  [/\bbatt(?:ery)?\b/i, "Battery"],
  [/\btire\b|\bwheel\b|\bt\s*&\s*w\b/i, "Tire and Wheel"],
  [/\btheft\b/i, "Theft"],
];

/** "USED BRONZE ATV - RIDERS ADVANTAGE PPM" to "Maintenance". Null when nothing says. */
export function categoryFromWording(name: unknown): string | null {
  if (typeof name !== "string") return null;
  return BY_WORDING.find(([re]) => re.test(name))?.[1] ?? null;
}

/** The catalog's word first, then the provider's type, then its name. */
export function categoryOf(p: { catalog?: string | null; ptype?: unknown; name?: unknown }): string | null {
  return (p.catalog && p.catalog.trim() !== "" ? p.catalog : null) ?? categoryForType(p.ptype) ?? categoryFromWording(p.name);
}

/** The noun for a kind of product, counted: "Maintenance plan", "Mechanical Protection plans". */
function plans(category: string, n: number): string {
  return `${category} ${n === 1 ? "plan" : "plans"}`;
}

/**
 * The note on Details for offers no menu row shows, one line per kind:
 * "2 Maintenance plans were offered but no menu row uses them." A type this
 * app has no word for is named by the provider's own type.
 */
export function unplacedNote(kind: string, n: number): string {
  return n === 1
    ? `1 ${plans(kind, 1)} was offered but no menu row uses it.`
    : `${n} ${plans(kind, n)} were offered but no menu row uses them.`;
}
