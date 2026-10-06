// components/admin/SignIn.tsx: the one sign-in form for the admin area.
//
// Shown by the admin layout to anyone not signed in, on whichever admin page
// they asked for. `next` carries that page through signIn, which sends them
// back to it, so a bookmark to /admin/wording still lands on Wording.

import { signIn } from "@/app/console-actions";

/** What the sign-in actions redirect with, in words. */
export const SIGN_IN_NOTICES: Record<string, string> = {
  denied: "Those details don't match an account with access.",
  slow: "Too many attempts. Wait a minute and try again.",
  broken: "Sign-in is unavailable right now. Try again shortly.",
  extendfailed: "That session's expiry could not be extended. Try again.",
  bad: "That wasn't a valid session.",
};

export function SignIn({ notice, next }: { notice: string | null; next: string }) {
  return (
    <main className="console console--gate">
      <form className="signin" action={signIn}>
        <p className="console-eyebrow">DocuRide PS Admin</p>
        <h1 className="signin-title">Sign in</h1>
        <p className="signin-body">
          Sign in with your DocuRide administrator account. The same email and
          password as the admin site.
        </p>

        {notice ? (
          <p className="signin-notice" role="alert">
            {notice}
          </p>
        ) : null}

        <input type="hidden" name="next" value={next} />

        <label className="signin-field">
          <span>Email</span>
          <input type="email" name="email" autoComplete="username" required autoFocus />
        </label>

        <label className="signin-field">
          <span>Password</span>
          <input type="password" name="password" autoComplete="current-password" required />
        </label>

        <button type="submit" className="btn btn--go signin-submit">
          Sign in
        </button>
      </form>
    </main>
  );
}
