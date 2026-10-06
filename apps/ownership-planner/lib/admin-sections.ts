// lib/admin-sections.ts: the sections of the DocuRide PS admin area.
//
// One list, read by the admin layout's menu. Adding a section is one entry
// here and a page at its href. Only built sections are listed: a menu item
// that leads to an empty page is worse than no item.
//
// No Next imports, so the list and the path rules can be tested directly.

export interface AdminSection {
  href: string;
  label: string;
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { href: "/admin/sessions", label: "Sessions" },
  { href: "/admin/wording", label: "Wording" },
];

/** Where the admin area opens, and where signing out lands. */
export const ADMIN_HOME = "/admin/sessions";

/**
 * A path inside the admin area that is safe to send someone back to after
 * signing in, or the admin home.
 *
 * Only an absolute path under /admin, with no second slash or backslash at the
 * start, so a crafted value cannot send a signed-in operator to another site.
 * Any query string or fragment is dropped: the page they asked for, not a
 * notice that was showing on it.
 */
export function safeAdminPath(next: unknown): string {
  if (typeof next !== "string") return ADMIN_HOME;
  const path = next.split(/[?#]/)[0];
  if (!/^\/admin(\/[A-Za-z0-9._~\-\/]*)?$/.test(path)) return ADMIN_HOME;
  if (path.includes("//") || path.includes("/..")) return ADMIN_HOME;
  return path === "/admin" || path === "/admin/" ? ADMIN_HOME : path;
}

/** The section a path belongs to, for highlighting it in the menu. */
export function sectionFor(path: string): AdminSection | null {
  return ADMIN_SECTIONS.find((s) => path === s.href || path.startsWith(`${s.href}/`)) ?? null;
}

/** A path with one query parameter added, the way the old pages carried notices. */
export function withNotice(path: string, key: string, value = "1"): string {
  return `${path}?${key}=${value}`;
}
