// components/admin/SignIn.tsx: the one sign-in form for the admin area.
//
// Shown by the admin layout to anyone not signed in, on whichever admin page
// they asked for. `next` carries that page through signIn, which sends them
// back to it, so a bookmark to /admin/wording still lands on Wording.

import { signIn } from "@/app/console-actions";
import { Brand, Notice } from "@/components/admin/Parts";

/** What the sign-in actions redirect with, in words. */
export const SIGN_IN_NOTICES: Record<string, string> = {
  denied: "Those details don't match an account with access.",
  slow: "Too many attempts. Wait a minute and try again.",
  broken: "Sign-in is unavailable right now. Try again shortly.",
  extendfailed: "That session's expiry could not be extended. Try again.",
  bad: "That wasn't a valid session.",
};

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

                <button type="submit" className="ad-btn ad-btn--primary">
                  Sign in
                </button>
              </div>
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}
