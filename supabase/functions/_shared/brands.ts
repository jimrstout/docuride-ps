// _shared/brands.ts: the make on a deal, as one known brand.
//
// Probes on deal 15063 (fni.rate_probes, 2026-11-02): only "Can-Am" got the
// full lineup; "CAN AM", "Can Am" and "BRP" silently lost GAP, Theft and every
// Mechanical Protection plan. The CRM's make is whatever someone typed, so:
//
//   1. Any reasonable spelling matches its brand: case, spaces, hyphens and
//      punctuation are ignored ("CAN AM", "can-am", "CanAm", "Can Am" are all
//      Can-Am), and a brand's aliases count too ("Yamaha Motor Corp., USA").
//   2. A parent company never maps by itself (fni.brand_groups). It narrows
//      the choice to its brands for the deal's vehicle type. When that leaves
//      one brand, or a brand is marked preferred there (Polaris on an On-Road
//      Motorcycle is Indian), it is pre-selected and marked "Check the brand",
//      and staff must confirm it before rating. Otherwise the choice starts
//      blank. A parent that is also a brand (Polaris on an ATV) is that brand.
//   3. Anything else starts blank and blocks rating until staff pick.
//   4. Staff's choice, recorded with who and when, is the brand from then on.
//
// Rating sends the provider's own spelling for the brand (spellingFor): a
// spelling settled for that provider, server and vehicle type
// (fni.brand_spellings), else the matching make in the provider's own list
// (fni.provider_makes), else the brand's name. Screens and stored values show
// the brand. The CRM is never changed.
//
// Pure, so a Node test can hold it.

export interface Brand {
  name: string;
  aliases: string[];
  active: boolean;
}

export interface BrandGroup {
  parent_name: string;
  brand_name: string;
  /** Our vehicle types this brand covers in the group. Empty: every type. */
  vehicle_types: string[];
  /** Pre-selected for these vehicle types even when others share them. */
  preferred: boolean;
}

/** The words that matter in a make, for comparing: "Can-Am" and "CAN AM" are both "canam". */
export function makeKey(make: unknown): string {
  return String(make ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type MakeResolution =
  /** A known brand: rate with it. */
  | { status: "brand"; brand: string; choices: string[]; crm: string; message: null }
  /** Pre-selected from the vehicle type: staff must confirm before rating. */
  | { status: "check"; brand: string; choices: string[]; crm: string; message: string }
  /** No brand yet: staff must pick before rating. */
  | { status: "choose"; brand: null; choices: string[]; crm: string; message: string };

/** "A", "A or B", "A, B or C". */
function orList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** The active brand a make names, by its name or an alias. */
export function brandFor(make: unknown, brands: Brand[]): Brand | null {
  const key = makeKey(make);
  if (key === "") return null;
  return brands.find((b) => b.active && (makeKey(b.name) === key || b.aliases.some((a) => makeKey(a) === key))) ?? null;
}

/** What a CRM make resolves to for this vehicle type, before anyone has chosen. */
export function resolveMake(crm: unknown, vehicleType: string | null, brands: Brand[], groups: BrandGroup[]): MakeResolution {
  const said = String(crm ?? "").trim();
  const all = brands.filter((b) => b.active).map((b) => b.name).sort((a, b) => a.localeCompare(b));
  if (said === "") {
    return { status: "choose", brand: null, choices: all, crm: said, message: "Pick the brand. The CRM has no make for this deal." };
  }
  const key = makeKey(said);
  const direct = brandFor(said, brands);
  const rows = groups.filter((g) => makeKey(g.parent_name) === key && brands.some((b) => b.active && b.name === g.brand_name));

  if (rows.length > 0) {
    const covers = (g: BrandGroup) => vehicleType === null || g.vehicle_types.length === 0 || g.vehicle_types.includes(vehicleType);
    const here = rows.filter(covers);
    const choices = (here.length > 0 ? here : rows).map((g) => g.brand_name);
    const preferred = here.filter((g) => g.preferred && vehicleType !== null && g.vehicle_types.includes(vehicleType));
    const check = (brand: string): MakeResolution => ({
      status: "check", brand, choices, crm: said,
      message: `Check the brand. The CRM says "${said}", and ${brand} is picked from the vehicle type. Confirm it before rating.`,
    });
    if (preferred.length === 1) return check(preferred[0].brand_name);
    // A parent that is itself a brand covering this vehicle type is that brand.
    if (direct && here.some((g) => g.brand_name === direct.name)) {
      return { status: "brand", brand: direct.name, choices: all, crm: said, message: null };
    }
    if (here.length === 1) return check(here[0].brand_name);
    return {
      status: "choose", brand: null, choices, crm: said,
      message: `Pick the brand. The CRM says "${said}", which is a parent company, not a brand: choose ${orList(choices)}.`,
    };
  }

  if (direct) return { status: "brand", brand: direct.name, choices: all, crm: said, message: null };
  return {
    status: "choose", brand: null, choices: all, crm: said,
    message: `Pick the brand. The CRM says '${said}', which doesn't match a known brand.`,
  };
}

/**
 * The brand to rate with: staff's choice when they made one, else what the
 * CRM's make resolves to. Only status "brand" may be rated.
 */
export function effectiveMake(
  crm: unknown,
  staffChoice: unknown,
  vehicleType: string | null,
  brands: Brand[],
  groups: BrandGroup[],
): MakeResolution {
  const chosen = staffChoice === null || staffChoice === undefined ? null : brandFor(staffChoice, brands);
  if (chosen) {
    return { status: "brand", brand: chosen.name, choices: brands.filter((b) => b.active).map((b) => b.name).sort((a, b) => a.localeCompare(b)), crm: String(crm ?? "").trim(), message: null };
  }
  return resolveMake(crm, vehicleType, brands, groups);
}

/** A spelling settled for a provider, server and vehicle type (fni.brand_spellings). */
export interface Spelling {
  provider_id: string;
  environment: string;
  vtype: string;
  brand_name: string;
  spelling: string;
}

/** One entry of the provider's own makes list (fni.provider_makes). */
export interface ProviderMake {
  provider_id: string;
  environment: string;
  vtype: string;
  make: string;
}

/**
 * The spelling the provider accepts for a brand on this server and vehicle
 * type: settled spelling, then its own list, then the brand's name. QA (Test)
 * and Live never borrow from each other.
 */
export function spellingFor(
  brand: Brand,
  where: { provider_id: string; environment: string; vtype: string },
  spellings: Spelling[],
  providerMakes: ProviderMake[],
): { spelling: string; source: "Settled" | "Provider list" | "Brand name" } {
  const same = (r: { provider_id: string; environment: string; vtype: string }) =>
    r.provider_id === where.provider_id && r.environment === where.environment && r.vtype.toUpperCase() === where.vtype.toUpperCase();
  const settled = spellings.find((s) => same(s) && s.brand_name === brand.name);
  if (settled) return { spelling: settled.spelling, source: "Settled" };
  const keys = new Set([brand.name, ...brand.aliases].map(makeKey));
  const listed = providerMakes.find((m) => same(m) && keys.has(makeKey(m.make)));
  if (listed) return { spelling: listed.make, source: "Provider list" };
  return { spelling: brand.name, source: "Brand name" };
}

/** The provider's makes list response, as rows: {vehicles: [{make, vtype}]}. */
export function makesFromResponse(response: unknown): { make: string; vtype: string }[] {
  const list = (response as { vehicles?: unknown } | null)?.vehicles;
  if (!Array.isArray(list)) return [];
  const out: { make: string; vtype: string }[] = [];
  for (const v of list as Record<string, unknown>[]) {
    const make = typeof v?.make === "string" ? v.make.trim() : "";
    const vtype = typeof v?.vtype === "string" ? v.vtype.trim() : "";
    if (make !== "" && vtype !== "") out.push({ make, vtype });
  }
  return out;
}

/** The form field "Brand checked": staff confirm a brand pre-selected from the vehicle type. */
export const MAKE_CONFIRMED = "unit_make_confirmed";

export const NO_MECHANICAL = "No Mechanical Protection came back. Check the brand and engine size.";
export const NO_GAP = "No GAP came back. Check the brand and engine size.";

/**
 * The safety net: a financed rating with no Mechanical Protection or no GAP
 * says so on Details, never silently. Categories are by the provider's type
 * (_shared/product-category.ts): VSA is Mechanical Protection.
 */
export function shortLineup(productTypes: string[], financed: boolean): string[] {
  if (!financed || productTypes.length === 0) return [];
  const types = new Set(productTypes.map((t) => t.toUpperCase()));
  const out: string[] = [];
  if (!types.has("VSA")) out.push(NO_MECHANICAL);
  if (!types.has("GAP")) out.push(NO_GAP);
  return out;
}
