// The Details page's source: the server page (page.tsx), which reads the deal,
// and the body it draws (DetailsBody.tsx), which holds everything on the
// screen. Speed part 2 split them so Rate again can update the body in place;
// tests that check what Details shows read both, as one.

import { readFileSync } from "node:fs";

const DIR = new URL("../apps/ownership-planner/app/details/[sessionId]/", import.meta.url);

export function detailsSource() {
  return readFileSync(new URL("page.tsx", DIR), "utf8") + "\n" + readFileSync(new URL("DetailsBody.tsx", DIR), "utf8");
}

const FUNCTIONS = new URL("../supabase/functions/", import.meta.url);

/**
 * fni-session-verify's source with the module it builds the rating's part of
 * the sheet with (_shared/details-offer.ts), as one: speed part 2 moved that
 * part there so Rate again answers with the same.
 */
export function verifySource() {
  return readFileSync(new URL("fni-session-verify/index.ts", FUNCTIONS), "utf8") + "\n" +
    readFileSync(new URL("_shared/details-offer.ts", FUNCTIONS), "utf8");
}
