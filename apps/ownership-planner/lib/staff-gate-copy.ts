// lib/staff-gate-copy.ts: what a screen says when nobody is signed in.
//
// Two audiences, two answers.
//
// Staff screens (Details, Prepare presentation, the admin area) show the
// sign-in form in place, and signing in returns to the same screen.
//
// The customer's tabs (Present menu, Present storyboard) never show a sign-in
// form and never link to a staff screen. They are opened by a signed-in staff
// member, in that staff member's browser, and inherit the sign-in. Opened
// anywhere else they say only that the dealership opens them, in words that
// make sense to a customer.
//
// No imports on purpose: the customer's tabs read this file, and nothing of
// the staff side (its sign-in form, its stylesheet) should come with it.

/** The customer tab's screen with no staff sign-in on this browser. */
export const CUSTOMER_TAB_SIGNED_OUT = {
  title: "Your dealership opens this for you",
  body: "Ask the person helping you to open it on their screen. It takes them one click.",
} as const;
