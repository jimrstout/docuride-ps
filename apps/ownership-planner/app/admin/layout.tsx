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

import Link from "next/link";
import { headers } from "next/headers";
import { currentOperator } from "@/lib/admin-session";
import { ADMIN_SECTIONS, safeAdminPath, sectionFor } from "@/lib/admin-sections";
import { SignIn, SIGN_IN_NOTICES } from "@/components/admin/SignIn";
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

  return (
    <div className="admin">
      <aside className="admin-side">
        <p className="admin-brand">DocuRide PS Admin</p>
        <nav className="admin-nav" aria-label="Admin sections">
          {ADMIN_SECTIONS.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              prefetch={false}
              className={s.href === here?.href ? "admin-nav-link is-here" : "admin-nav-link"}
              aria-current={s.href === here?.href ? "page" : undefined}
            >
              {s.label}
            </Link>
          ))}
        </nav>
        <form action={signOut} className="admin-who">
          <span>{operator.email}</span>
          <button type="submit" className="btn btn--quiet">
            Sign out
          </button>
        </form>
      </aside>
      <main className="admin-main">{children}</main>
    </div>
  );
}
