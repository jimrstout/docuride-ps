// _shared/brand-admin.ts: what Administration > Brands may save.
//
// Brands, parent-company groupings and the provider's spellings (migration
// 0056, _shared/brands.ts) are kept in tables so a change of ownership, a new
// brand or a spelling the provider changed is an edit, not a deploy. This
// checks what the page sends, one plain sentence per problem.
//
// Pure, so a Node test can hold it.

import { VEHICLE_TYPES } from "./vehicle-types.ts";

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Yamaha Motor Corp., USA; Yamaha Motor Corporation" to two aliases. Semicolons, since a name may hold a comma. */
export function aliasList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : text(v).split(";");
  return [...new Set(raw.map((a) => a.trim()).filter((a) => a !== ""))];
}

export interface BrandFields {
  name: string;
  aliases: string[];
  active: boolean;
}

export function parseBrand(body: Record<string, unknown>): { fields: BrandFields } | { error: string } {
  const name = text(body.name);
  if (name === "") return { error: "Give the brand a name, such as Can-Am." };
  if (name.length > 60) return { error: "A brand name is at most 60 characters." };
  return { fields: { name, aliases: aliasList(body.aliases).filter((a) => a !== name), active: body.active === true || body.active === "on" } };
}

export interface GroupFields {
  parent_name: string;
  brand_name: string;
  vehicle_types: string[];
  preferred: boolean;
  note: string | null;
}

export function parseGroup(body: Record<string, unknown>, brandNames: string[]): { fields: GroupFields } | { error: string } {
  const parent = text(body.parent_name);
  const brandName = text(body.brand_name);
  if (parent === "") return { error: "Give the parent company's name, such as BRP." };
  if (!brandNames.includes(brandName)) return { error: "Choose one of the brands listed." };
  const types = (Array.isArray(body.vehicle_types) ? body.vehicle_types : text(body.vehicle_types).split(","))
    .map((t) => String(t).trim()).filter((t) => t !== "");
  const unknown = types.filter((t) => !(VEHICLE_TYPES as readonly string[]).includes(t));
  if (unknown.length > 0) return { error: `${unknown[0]} is not a vehicle type.` };
  const preferred = body.preferred === true || body.preferred === "on";
  if (preferred && types.length === 0) return { error: "A preferred brand needs the vehicle types it is preferred for." };
  const note = text(body.note);
  return { fields: { parent_name: parent, brand_name: brandName, vehicle_types: types, preferred, note: note === "" ? null : note } };
}

export interface SpellingFields {
  provider_id: string;
  environment: "Test" | "Live";
  vtype: string;
  brand_name: string;
  spelling: string;
  note: string | null;
}

export function parseSpelling(body: Record<string, unknown>, brandNames: string[]): { fields: SpellingFields } | { error: string } {
  const provider = text(body.provider_id);
  if (!UUID.test(provider)) return { error: "Choose the provider." };
  const environment = text(body.environment);
  if (environment !== "Test" && environment !== "Live") return { error: "Choose QA (Test) or live." };
  const vtype = text(body.vtype).toUpperCase();
  if (!/^[A-Z]{2,10}$/.test(vtype)) return { error: "Give the provider's vehicle type code, such as MCYC or PWAC." };
  const brandName = text(body.brand_name);
  if (!brandNames.includes(brandName)) return { error: "Choose one of the brands listed." };
  const spelling = text(body.spelling);
  if (spelling === "" || spelling.length > 60) return { error: "Give the spelling the provider accepts, as it writes it." };
  const note = text(body.note);
  return { fields: { provider_id: provider, environment, vtype, brand_name: brandName, spelling, note: note === "" ? null : note } };
}
