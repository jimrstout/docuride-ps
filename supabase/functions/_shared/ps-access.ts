// _shared/ps-access.ts: which stores a signed-in person sees in the PS admin area.
//
// Kept in fni (migration 0058), never in public.profiles:
//   fni.staff_roles         "Administrator" or "Staff"
//   fni.staff_store_access  the stores a Staff user may see
//
// The rule:
//   Administrator   every store, and manages staff on Administration > Staff
//   Staff           only the stores granted to them; none granted, none seen
//   no role row     a platform administrator (the flag sign-in already reads)
//                   is an Administrator, so nobody who uses the admin area
//                   today loses it; anyone else has no PS access
//
// Enforced on the server by fni-admin-sessions: the list is filtered by these
// stores before anything is sent, so the browser never receives a session
// from a store the person cannot see. Details and the customer presentation
// are not governed by this.
//
// Pure, so a Node test can hold it.

export const PS_ROLES = ["Administrator", "Staff"] as const;
export type PsRole = (typeof PS_ROLES)[number];

/** What a person with no stores is told, word for word. */
export const NO_STORES_MESSAGE = "No stores assigned. Ask an administrator for access.";

export interface PsAccess {
  role: PsRole;
  /** The stores they may see; null means every store (an Administrator). */
  storeIds: string[] | null;
}

export function isPsRole(v: unknown): v is PsRole {
  return typeof v === "string" && (PS_ROLES as readonly string[]).includes(v);
}

/** Their access, or null when they have none. */
export function accessFrom(role: unknown, granted: string[], platformAdmin: boolean): PsAccess | null {
  const r: PsRole | null = isPsRole(role) ? role : platformAdmin ? "Administrator" : null;
  if (!r) return null;
  return { role: r, storeIds: r === "Administrator" ? null : [...new Set(granted)].sort() };
}

/** May they see this store's sessions? */
export function maySee(access: PsAccess, storeId: unknown): boolean {
  if (access.storeIds === null) return true;
  return typeof storeId === "string" && access.storeIds.includes(storeId);
}

/** A store's name as the CRM writes it ("All Seasons Powersports, Parkersburg"), else its short name. */
export function storeFullName(store: { name: string; zoho_store_location?: string | null }): string {
  const full = (store.zoho_store_location ?? "").trim();
  return full !== "" ? full : store.name;
}

/** By store name, then most recent first within each store. */
export function byStoreThenRecent<T extends { store_name: string | null; created_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    (a.store_name ?? "￿").localeCompare(b.store_name ?? "￿") || Date.parse(b.created_at) - Date.parse(a.created_at)
  );
}
