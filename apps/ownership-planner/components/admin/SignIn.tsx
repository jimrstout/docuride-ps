// components/admin/SignIn.tsx: the one staff sign-in form.
//
// Shown in place of any staff screen to anyone not signed in: every admin
// page (by the admin layout), Details and Prepare presentation. `next` carries
// that page through signIn, which sends them back to it, so a CRM launch onto
// one deal's Details lands back on that deal's Details after signing in.
//
// It carries nothing about the page it stands in for: no deal number, no
// buyer, no field. The customer's tabs never show it: see lib/staff-gate-copy.ts.

// The admin look, which this form wears wherever it is shown. Its rules all
// sit under .ad, so importing it on Details changes nothing else there.
import "@/app/admin/admin.css";
import { signIn } from "@/app/console-actions";
import Control from "@/components/Control";
import { Working } from "@/components/Working";
import { Brand, Notice } from "@/components/admin/Parts";

/** What the sign-in actions redirect with, in words. */
export const SIGN_IN_NOTICES: Record<string, string> = {
  denied: "Those details don't match an account with access.",
  slow: "Too many attempts. Wait a minute and try again.",
  broken: "Sign-in is unavailable right now. Try again shortly.",
  bad: "That wasn't a valid session.",
};

/** The notice signIn redirected back with (?denied=1 and the rest), from a page's query. */
export function signInNotice(query: Record<string, string | string[] | undefined> | undefined): string | null {
  const key = Object.keys(SIGN_IN_NOTICES).find((k) => query && k in query);
  return key ? SIGN_IN_NOTICES[key] : null;
}

export function SignIn({ notice, next }: { notice: string | null; next: string }) {
  // The admin shell without the section links: nobody signed in has anywhere
  // to go yet.
  return (
    <div className="ad">
      <aside className="ad-side">
        <Brand />
      </aside>
      <div className="ad-body">
        <main className="ad-gate">
          <div className="ad-signin">
            <form className="ad-panel" action={signIn}>
              <Working />
              <div className="ad-panel-body">
                <div>
                  <h1>Sign in</h1>
                  <p className="ad-help">
                    Use your DocuRide administrator account. The same email and
                    password as the admin site.
                  </p>
                </div>

                {notice ? <Notice tone="warn">{notice}</Notice> : null}

                <input type="hidden" name="next" value={next} />

                <label className="ad-field">
                  <span>Email</span>
                  <input type="email" name="email" autoComplete="username" required autoFocus />
                </label>

                <label className="ad-field">
                  <span>Password</span>
                  <input type="password" name="password" autoComplete="current-password" required />
                </label>

                <Control type="submit" className="ad-btn ad-btn--primary" busyText="Signing in...">
                  Sign in
                </Control>
              </div>
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}
