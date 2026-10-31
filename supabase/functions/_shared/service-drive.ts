// _shared/service-drive.ts
//
// DocuRide PS sells only at the time of the vehicle sale (docs/multi-provider.md
// section 28). Service drive products are sold afterwards, in the service
// department, and are not supported:
//
//   The Service Drive Surcharge   an option marking a product sold after the
//                                 vehicle sale, not a vehicle surcharge. Never
//                                 offered, never sent.
//   Service drive plans           never offered: not on Prepare menu, the menu,
//                                 the planner or the preset pickers.
//
// ── How the provider marks a service drive plan (rated offers, 2026-10-31) ──
// Only by its name. The label carries "CARE-SVC DRIVE" and the blurb "- SERVICE
// DRIVE" (USED ATV/UTV CARE-SVC DRIVE 86_3, USED ON-ROAD CARE-SVC DRIVE 88_3,
// and their Premium versions 2064_141 and 2066_141). There is no flag: the
// product's properties are empty, its attributes carry only a product code, and
// its rate class is the point-of-sale plan's. The Care Coverage pair also carry
// the Service Drive Surcharge as mandatory on every rate, so that is a second
// signal; the Premium pair carry no surcharge at all, so the name is the one
// that finds all four. Our catalog names them "..., Service Drive".
//
// Pure, so a Node test can hold it.

/** "Service Drive", "Service_Drive", "Service Drive Surcharge": the provider's code or name for it. */
const SURCHARGE = /^service[\s_-]*drive(?:[\s_-]*surcharge)?$/i;

/** The Service Drive Surcharge, by the option's code or its label. */
export function isServiceDriveOption(o: { code?: unknown; unique?: unknown; label?: unknown }): boolean {
  return [o.code, o.unique, o.label].some((v) => typeof v === "string" && SURCHARGE.test(v.trim()));
}

/** "SVC DRIVE", "Service Drive", "SERVICE-DRIVE" in a plan's name. */
const PLAN_NAME = /\b(?:svc|service)[\s_.-]*drive\b/i;

/** A plan name, the provider's or the catalog's, that marks a service drive plan. */
export function isServiceDriveName(name: unknown): boolean {
  return typeof name === "string" && PLAN_NAME.test(name);
}

/** A rated plan sold only on the service drive: by its names, or a Service Drive Surcharge it must carry. */
export function isServiceDrivePlan(t: {
  product_name?: unknown;
  raw?: Record<string, unknown> | null;
  rates?: { options?: { code?: unknown; label?: unknown; mandatory?: unknown }[] | null }[];
}): boolean {
  const raw = t.raw ?? {};
  if ([t.product_name, raw.label, raw.desc, raw.blurb].some(isServiceDriveName)) return true;
  return (t.rates ?? []).some((r) => (r.options ?? []).some((o) => o.mandatory === true && isServiceDriveOption(o)));
}

/** The note on a Prepare menu cell whose preset names a service drive plan. */
export function serviceDrivePresetNote(fallback: string | null): string {
  return fallback
    ? `Preset plan is for service drive sales only; using ${fallback} instead.`
    : "Preset plan is for service drive sales only, and no other plan is offered here.";
}

// ── A selection already on a service drive plan ──────────────────────────
// Saved before these plans were left out. It is not changed: staff see a plain
// line on Details and Prepare menu, and Submit refuses it with the same words.

export const SERVICE_DRIVE_EVENT = "Submit stopped: a service drive plan cannot be submitted";

/** "Mechanical Protection, Service Drive is a service drive plan and cannot be submitted." */
export function serviceDriveLine(name: string): string {
  return `${name} is a service drive plan and cannot be submitted.`;
}

export interface SavedSelection {
  provider_product_id: string | null;
  product_name: string | null;
  disposition?: string | null;
  rate_snapshot?: unknown;
}

/**
 * The Included selections on a service drive plan, each named as the catalog
 * names it (else as saved). By name, the catalog's or the saved one, or a
 * Service Drive Surcharge the saved rate had to carry.
 */
export function serviceDriveSelections(rows: SavedSelection[], catalogNames: Record<string, string>): { code: string; name: string }[] {
  const out: { code: string; name: string }[] = [];
  for (const r of rows) {
    if (r.disposition !== undefined && r.disposition !== "Included") continue;
    const code = r.provider_product_id ?? "";
    const catalog = catalogNames[code] ?? null;
    const options = ((r.rate_snapshot as { options?: unknown } | null)?.options ?? []) as { code?: unknown; unique?: unknown; label?: unknown; mandatory?: unknown }[];
    const mandatory = Array.isArray(options) && options.some((o) => o?.mandatory === true && isServiceDriveOption(o));
    if (isServiceDriveName(catalog) || isServiceDriveName(r.product_name) || mandatory) {
      if (!out.some((o) => o.code === code)) out.push({ code, name: catalog ?? r.product_name ?? "A product" });
    }
  }
  return out;
}

/** A product in a rated quote, by its unique, as the provider sent it. */
export function quoteProduct(payload: unknown, unique: string): Record<string, unknown> | null {
  const root = (payload as { quote?: unknown } | null)?.quote ?? payload;
  const vehicles = ((root as { vehicles?: unknown } | null)?.vehicles ?? []) as { products?: unknown }[];
  for (const v of Array.isArray(vehicles) ? vehicles : []) {
    for (const p of (Array.isArray(v?.products) ? v.products : []) as Record<string, unknown>[]) {
      if (String(p?.unique ?? "") === unique) return p;
    }
  }
  return null;
}

/** A product in a rated quote that is a service drive plan: its label, blurb or a mandatory Service Drive Surcharge. */
export function isServiceDriveQuoteProduct(payload: unknown, unique: string): boolean {
  const p = quoteProduct(payload, unique);
  if (!p) return false;
  const rates = (Array.isArray(p.rates) ? p.rates : []) as { options?: unknown }[];
  return isServiceDrivePlan({
    product_name: p.label ?? p.desc,
    raw: p,
    rates: rates.map((r) => ({ options: (Array.isArray(r?.options) ? r.options : []) as { code?: unknown; label?: unknown; mandatory?: unknown }[] })),
  });
}

/** The session's lines for Details and Prepare menu: one per Included selection on a service drive plan. */
export async function serviceDriveLines(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  sessionId: string
): Promise<string[]> {
  const { data } = await supabase.schema("fni").from("selected_products")
    .select("provider_product_id, product_name, disposition, rate_snapshot").eq("session_id", sessionId).eq("disposition", "Included");
  const rows = (data ?? []) as SavedSelection[];
  if (rows.length === 0) return [];
  const codes = [...new Set(rows.map((r) => r.provider_product_id).filter((c): c is string => !!c))];
  const { data: catalog } = codes.length
    ? await supabase.schema("fni").from("product_catalog").select("product_code, display_name").in("product_code", codes).is("store_id", null)
    : { data: [] };
  const names = Object.fromEntries(((catalog ?? []) as { product_code: string; display_name: string }[]).map((c) => [c.product_code, c.display_name]));
  return serviceDriveSelections(rows, names).map((s) => serviceDriveLine(s.name));
}
