// app/admin/layout.tsx: the DocuRide PS admin area.
//
// One door for every staff page. The menu is built from ADMIN_SECTIONS, so a
// new section is one entry there. Nothing customer-facing links here: the
// planner has no route to /admin, and a test holds it to that.
//
// ── The sign-in check ───────────────────────────────────────────────────
// Made once, here. Signed out, the page asked for is not rendered at all: the
// sign-in form is, and signing in returns to that page. Each page also reads
// the same cached answer before it fetches anything (see currentOperator), so
// a signed-out request never causes a read of the data behind the page.
//
// ── The look ────────────────────────────────────────────────────────────
// admin.css, imported here and only here. Its rules all sit under .ad, the
// class on the root element below, so nothing of it reaches the planner or
// Verify.

import "./admin.css";
import Link from "next/link";
import { headers } from "next/headers";
import { currentOperator } from "@/lib/admin-session";
import { ADMIN_SECTIONS, initialsFor, safeAdminPath, sectionFor } from "@/lib/admin-sections";
import { SignIn, SIGN_IN_NOTICES } from "@/components/admin/SignIn";
import { Brand } from "@/components/admin/Parts";
import { Icon } from "@/components/admin/Icon";
import { signOut } from "@/app/console-actions";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const path = safeAdminPath(h.get("x-admin-path"));
  const operator = await currentOperator();

  if (!operator) {
    const query = new URLSearchParams(h.get("x-admin-search") ?? "");
    const key = Object.keys(SIGN_IN_NOTICES).find((k) => query.has(k));
    return <SignIn notice={key ? SIGN_IN_NOTICES[key] : null} next={path} />;
  }

  const here = sectionFor(path);

  // Shown twice: in the sidebar, and in the top bar on a phone, where the
  // sidebar becomes a row of icons. CSS shows one of them.
  const signOutForm = (
    <form action={signOut}>
      <button type="submit" className="ad-signout">
        Sign out
      </button>
    </form>
  );

  return (
    <div className="ad">
      <aside className="ad-side">
        <Link href="/admin/sessions" prefetch={false} className="ad-brand-link">
          <Brand />
        </Link>
        <nav className="ad-nav" aria-label="Admin sections">
          {ADMIN_SECTIONS.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              prefetch={false}
              className={s.href === here?.href ? "ad-nav-link is-here" : "ad-nav-link"}
              aria-current={s.href === here?.href ? "page" : undefined}
            >
              <Icon name={s.icon} />
              <span className="ad-nav-label">{s.label}</span>
            </Link>
          ))}
        </nav>
        <div className="ad-side-foot">
          <span className="ad-side-email">{operator.email}</span>
          {signOutForm}
        </div>
      </aside>

      <div className="ad-body">
        <header className="ad-top">
          <p className="ad-crumb">
            Administration<span className="ad-slash" aria-hidden="true">/</span>
            <strong>{here?.label ?? "Sessions"}</strong>
          </p>
          <div className="ad-me">
            <span className="ad-avatar" aria-hidden="true">{initialsFor(operator.email)}</span>
            <span className="ad-me-name">{operator.email}</span>
            {signOutForm}
          </div>
        </header>
        <main className="ad-main">{children}</main>
      </div>
    </div>
  );
}
