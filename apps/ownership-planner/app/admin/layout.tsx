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
import Control from "@/components/Control";
import HomeLink, { HOME_HREF } from "@/components/HomeLink";
import { headers } from "next/headers";
import { currentOperator } from "@/lib/admin-session";
import { initialsFor, safeAdminPath, sectionsFor } from "@/lib/admin-sections";
import { edge } from "@/lib/edge";
import { SignIn, SIGN_IN_NOTICES } from "@/components/admin/SignIn";
import { Brand } from "@/components/admin/Parts";
import { signOut } from "@/app/console-actions";
import { WorkingArea } from "@/components/Working";
import AdminMenu from "@/components/admin/AdminMenu";
import AdminNav, { AdminCrumbHere } from "@/components/admin/AdminNav";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const path = safeAdminPath(h.get("x-admin-path"));
  const operator = await currentOperator();

  if (!operator) {
    const query = new URLSearchParams(h.get("x-admin-search") ?? "");
    const key = Object.keys(SIGN_IN_NOTICES).find((k) => query.has(k));
    return (
      <WorkingArea>
        <SignIn notice={key ? SIGN_IN_NOTICES[key] : null} next={path} />
      </WorkingArea>
    );
  }

  // The person's PS role decides the menu (migration 0058). If it cannot be
  // read, the menu is as before; each page's own data is checked on the server.
  const role = await edge.adminMe<{ role?: string }>().then((m) => m.role ?? null).catch(() => null);
  const sections = sectionsFor(role);

  // Shown twice: in the sidebar, and in the top bar on a phone, where the
  // sidebar becomes a row of icons. CSS shows one of them.
  const signOutForm = (
    <form action={signOut}>
      <Control type="submit" className="ad-signout" busyText="Signing out...">
        Sign out
      </Control>
    </form>
  );

  return (
    <WorkingArea>
    <div className="ad">
      <aside className="ad-side">
        <Control href={HOME_HREF} className="ad-brand-link">
          <Brand />
        </Control>
        {/* A phone or a narrow tablet: the sections by name, behind a Menu button. */}
        <AdminMenu sections={sections} />
        {/* The highlight and the breadcrumb follow the address on the client: this layout does not re-render between its pages. */}
        <AdminNav sections={sections} />
        <div className="ad-side-foot">
          <span className="ad-side-email">{operator.email}</span>
          {signOutForm}
        </div>
      </aside>

      <div className="ad-body">
        <header className="ad-top">
          <p className="ad-crumb">
            <HomeLink />
            {/* Left out on a small screen: the home link and the page are enough. */}
            <span className="ad-crumb-mid">
              <span className="ad-slash" aria-hidden="true">/</span>
              Administration
            </span>
            <span className="ad-slash" aria-hidden="true">/</span>
            <AdminCrumbHere />
          </p>
          {/* A page's own choice for the whole page (the Sessions store choice), left of the email. */}
          <div className="ad-top-tools" id="ad-top-tools" />
          <div className="ad-me">
            <span className="ad-avatar" aria-hidden="true">{initialsFor(operator.email)}</span>
            <span className="ad-me-name">{operator.email}</span>
            {signOutForm}
          </div>
        </header>
        <main className="ad-main">{children}</main>
      </div>
    </div>
    </WorkingArea>
  );
}
