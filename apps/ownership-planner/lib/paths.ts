// lib/paths.ts
//
// The planner is served under /ps on the main site, so next.config.mjs sets
// basePath. Next prefixes everything it routes itself: pages, next/link, the
// router, and the sources in headers/redirects/rewrites.
//
// It does NOT prefix a plain fetch() from a client component -- that is a raw
// browser request, and Next never sees the URL to rewrite it. So every
// client-side call to our own API goes through apiPath(), or it resolves
// against the root site and 404s.
//
// The failure is quiet, which is the reason this file exists rather than a
// convention: a 404 on the autosave does not stop the customer, it just means
// nothing they decided was recorded.

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Prefix an app-absolute path with the base path. Pass a leading slash. */
export function apiPath(path: string): string {
  return `${BASE_PATH}${path}`;
}
