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
