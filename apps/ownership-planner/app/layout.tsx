import type { Metadata } from "next";
import "./tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "DocuRide PS Ownership Planner",
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
      <body>{children}</body>
    </html>
  );
}
