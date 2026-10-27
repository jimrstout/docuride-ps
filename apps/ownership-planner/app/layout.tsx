import type { Metadata, Viewport } from "next";
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

// The width of the device, never zoomed out to fit a wider page. "cover" lets
// the page reach the edges of an iPhone screen; the safe-area padding in
// globals.css and admin.css keeps text and buttons clear of the notch and the
// home bar.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
