// _shared/presentation.ts
//
// Which presentation recorded a customer's choices, and what it says on the
// session's record (2026-10-30). Two paths out of one session:
//
//   Ownership Planner   the guided planner (/plan). A save that names no path
//                       is the planner's: it predates the menu and sends none.
//   Conventional Menu   the package columns (/menu), staff-presented.
//
// Session events, signed with the signed-in person's initials or "System":
//
//   "Conventional menu opened"                      when the menu loads
//   "Package selected on the conventional menu: Gold"
//   "Everything declined on the conventional menu"
//
// "Presented by <name>, dealership staff" goes on the acknowledgment when a
// staff member was signed in (sessions.presented_by_name).
//
// Pure, so a Node test can hold it.

export const PRESENTATION_PATHS = ["Ownership Planner", "Conventional Menu"] as const;
export type PresentationPath = (typeof PRESENTATION_PATHS)[number];

export const PLANNER = "Ownership Planner";
export const MENU = "Conventional Menu";

export const MENU_OPENED_EVENT = "Conventional menu opened";
export const MENU_DECLINED_EVENT = "Everything declined on the conventional menu";
export const MENU_SELECTED_PREFIX = "Package selected on the conventional menu: ";

export function isPresentationPath(v: unknown): v is PresentationPath {
  return typeof v === "string" && (PRESENTATION_PATHS as readonly string[]).includes(v);
}

/** The path a save records: the one it names, or the planner's. */
export function pathForSave(v: unknown): PresentationPath {
  return isPresentationPath(v) ? v : PLANNER;
}

export interface MenuEvent {
  kind: "opened" | "selected" | "declined";
  package?: string;
}

/** A menu event as the browser sent it, or null when it is not one. */
export function parseMenuEvent(v: unknown): MenuEvent | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (e.kind === "opened" || e.kind === "declined") return { kind: e.kind };
  if (e.kind === "selected" && typeof e.package === "string" && e.package.trim() !== "") {
    return { kind: "selected", package: e.package.trim().slice(0, 40) };
  }
  return null;
}

/** The event's wording on the session's record. */
export function menuEventName(e: MenuEvent): string {
  if (e.kind === "opened") return MENU_OPENED_EVENT;
  if (e.kind === "declined") return MENU_DECLINED_EVENT;
  return `${MENU_SELECTED_PREFIX}${e.package}`;
}

/** Who signs an event: initials, or System. */
export function signedBy(v: unknown): string {
  if (typeof v !== "string") return "System";
  const s = v.trim().toUpperCase();
  return /^[A-Z0-9]{1,4}$/.test(s) ? s : "System";
}

/** A presenter's name as it goes on the acknowledgment, or null. */
export function presenterName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s === "" ? null : s.slice(0, 80);
}
