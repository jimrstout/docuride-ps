/**
 * The planner is served under a path on the main site (docuride.com/ps/...)
 * via a rewrite, not on its own hostname. Without basePath every asset request
 * resolves against the root site and 404s.
 *
 * Defined once here and handed to the client as NEXT_PUBLIC_BASE_PATH, because
 * Next only prefixes what it routes itself -- pages, next/link, the router,
 * headers, redirects and rewrites. A plain fetch("/api/...") in a client
 * component is not routed by Next and is NOT prefixed, so lib/paths.ts does
 * that explicitly. See the note there.
 */
const BASE_PATH = "/ps";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  basePath: BASE_PATH,

  // assetPrefix defaults to basePath, so _next/* already resolves under /ps.

  env: {
    // Inlined at build time, so client code can prefix the paths Next does not.
    NEXT_PUBLIC_BASE_PATH: BASE_PATH,
  },

  // A session URL carries the only credential protecting buyer PII. Sending it
  // in a referrer to a third party would hand that credential away, so the
  // planner never sends one.
  //
  // These sources are relative to basePath -- Next applies it for us, so
  // "/plan/:path*" matches /ps/plan/... in production.
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
