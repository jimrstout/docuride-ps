/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // A session URL carries the only credential protecting buyer PII. Sending it
  // in a referrer to a third party would hand that credential away, so the
  // planner never sends one.
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
