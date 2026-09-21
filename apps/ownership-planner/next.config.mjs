/**
 * The planner is served on its own hostname, ps.docuride.com, so it sits at the
 * root of that origin and needs no path prefix. BASE_PATH is empty.
 *
 * It is kept as a named constant, and still handed to the client as
 * NEXT_PUBLIC_BASE_PATH, because the prefix has to be applied in two places
 * that cannot see each other: Next prefixes what it routes itself -- pages,
 * next/link, the router, headers, redirects and rewrites -- while a plain
 * fetch("/api/...") in a client component is never routed by Next and is not
 * prefixed. lib/paths.ts does that half explicitly.
 *
 * Setting BASE_PATH back to a path (e.g. "/ps", to serve the app under a path
 * on the main site again) is therefore the only edit needed: both halves read
 * from here. Setting NEXT_PUBLIC_BASE_PATH in the hosting environment instead
 * would move only the client half and silently break the other.
 */
const BASE_PATH = "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Omitted entirely when empty: Next's default is no prefix, and assetPrefix
  // follows basePath, so _next/* resolves at the root of the hostname.
  ...(BASE_PATH ? { basePath: BASE_PATH } : {}),

  env: {
    // Inlined at build time, so client code can prefix the paths Next does not.
    NEXT_PUBLIC_BASE_PATH: BASE_PATH,
  },

  // A session URL carries the only credential protecting buyer PII. Sending it
  // in a referrer to a third party would hand that credential away, so the
  // planner never sends one.
  //
  // These sources are relative to basePath -- Next applies it for us, so
  // "/plan/:path*" matches /plan/... on ps.docuride.com today, and would match
  // /ps/plan/... unchanged if BASE_PATH were set again.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
      {
        // A plan is per-buyer and must never be cached by a shared proxy.
        source: "/plan/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, private" }],
      },
    ];
  },
};

export default nextConfig;
