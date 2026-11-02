// lib/presenter.ts: who is presenting, from this browser's own cookies.
//
// The planner and the conventional menu open in a customer tab, but on a
// dealership device a staff member is usually signed in on the same browser.
// When one is, their initials sign the session events and their name goes on
// the acknowledgment: "Presented by <name>, dealership staff". The name is made
// from the signed-in email ("jim.stout" reads "Jim Stout"). Read here, on the server,
// never sent by the browser, so a customer cannot put a name on the record.

import "server-only";
import { currentOperator } from "./admin-session";
import { initialsFor, nameFromEmail } from "./admin-sections";

/** The signed-in staff member, or nothing when no one is signed in here. */
export async function presenter(): Promise<{ presented_by?: string; presented_by_name?: string }> {
  const operator = await currentOperator();
  if (!operator) return {};
  const name = nameFromEmail(operator.email);
  return { presented_by: initialsFor(operator.email), presented_by_name: name || undefined };
}
