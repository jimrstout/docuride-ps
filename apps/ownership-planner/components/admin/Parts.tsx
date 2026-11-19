// components/admin/Parts.tsx: the pieces every admin page is built from.
//
// The brand, a page heading, and the badge-styled notice. Kept here so the
// three pages and the sign-in screen cannot drift apart in how they look.

export function Brand() {
  return (
    <span className="ad-brand">
      <span className="ad-brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 16a8 8 0 1 1 16 0" />
          <path d="M12 16l4-5" />
          <path d="M4 20h16" />
        </svg>
      </span>
      <span>
        <span className="ad-brand-name">
          DocuRide <span>PS</span>
        </span>
        <span className="ad-brand-sub">Administration</span>
      </span>
    </span>
  );
}

/** A page's title, its one-line subtitle, and whatever sits to its right. */
export function PageHead({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="ad-head">
      <div>
        <h1>{title}</h1>
        <p className="ad-head-sub">{subtitle}</p>
      </div>
      {children ? <div className="ad-head-side">{children}</div> : null}
    </header>
  );
}

export type Tone = "good" | "plain" | "warn";

export function Badge({ tone = "plain", children }: { tone?: Tone; children: React.ReactNode }) {
  const cls = tone === "good" ? "ad-badge ad-badge--good" : tone === "warn" ? "ad-badge ad-badge--warn" : "ad-badge";
  return <span className={cls}>{children}</span>;
}

/** Saved, refused, failed: one line at the top of the page, in a badge's colours. */
export function Notice({ tone, children }: { tone: "good" | "warn"; children: React.ReactNode }) {
  return (
    <p
      className={`ad-badge ad-notice ${tone === "good" ? "ad-badge--good" : "ad-badge--warn"}`}
      role={tone === "good" ? "status" : "alert"}
      data-working-result={tone === "good" ? "ok" : "bad"}
    >
      {children}
    </p>
  );
}
