// components/admin/Icon.tsx: the admin menu's line icons.
//
// Small inline stroke drawings, coloured by the link they sit in. Inline SVG
// rather than a font or a symbol character, so they render the same on every
// machine and need nothing loaded.

import type { AdminSection } from "@/lib/admin-sections";

const PATHS: Record<AdminSection["icon"], React.ReactNode> = {
  // A list of rows: the session browser.
  sessions: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 13h8M8 16.5h5" />
    </>
  ),
  // A price tag.
  pricing: (
    <>
      <path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9-9-9Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  // Lines of text.
  wording: <path d="M4 6h16M4 10.5h16M4 15h10M4 19.5h7" />,
};

export function Icon({ name }: { name: AdminSection["icon"] }) {
  return (
    <svg
      className="ad-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
