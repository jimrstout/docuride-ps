// _shared/service-drive.ts
//
// DocuRide PS sells only at the time of the vehicle sale (docs/multi-provider.md
// section 28). Service drive products are sold afterwards, in the service
// department, and are not supported:
//
//   The Service Drive Surcharge   an option marking a product sold after the
//                                 vehicle sale, not a vehicle surcharge. Never
//                                 offered, never sent.
//
// Pure, so a Node test can hold it.

/** "Service Drive", "Service_Drive", "Service Drive Surcharge": the provider's code or name for it. */
const SURCHARGE = /^service[\s_-]*drive(?:[\s_-]*surcharge)?$/i;

/** The Service Drive Surcharge, by the option's code or its label. */
export function isServiceDriveOption(o: { code?: unknown; unique?: unknown; label?: unknown }): boolean {
  return [o.code, o.unique, o.label].some((v) => typeof v === "string" && SURCHARGE.test(v.trim()));
}
