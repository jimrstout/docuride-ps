import type { Metadata } from "next";
import "./tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "DocuRide PS — Ownership Planner",
  description: "Plan how you'll own it.",
  // A session URL is the only credential protecting this page. Keep it out of
  // search indexes and out of referrers.
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Two faces, two jobs: Source Serif for headings, vehicle names and
            money; Inter for navigation, labels, controls and anything
            technical. The prototype declared Inter and never loaded it, so it
            rendered in Segoe UI or Arial on most machines. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
