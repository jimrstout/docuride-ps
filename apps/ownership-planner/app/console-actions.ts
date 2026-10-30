"use server";

// app/console-actions.ts — the console's writes.
//
// Server Actions rather than route handlers, and plain <form> elements rather
// than fetch, so the console works with no client JavaScript at all. That is
// not purity: it is the shortest path between "I clicked extend" and "the row
// says it is live again", with nothing in between that can be out of date.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { edge, EdgeError } from "@/lib/edge";
import {
  CONSOLE_COOKIE,
  CONSOLE_COOKIE_OPTIONS,
  currentOperator,
  mintConsoleCookie,
} from "@/lib/admin-session";
import {
  CHECKER_COOKIE,
  CHECKER_COOKIE_OPTIONS,
  checkerFor,
  cleanCheckerName,
} from "@/lib/checker";
import { ratingInputsFrom } from "@/lib/verify-fields";
import { ADMIN_HOME, initialsFor, safeAdminPath, withNotice } from "@/lib/admin-sections";

// The admin area's pages, as the actions below send people back to them.
const SESSIONS = ADMIN_HOME;
const WORDING = "/admin/wording";
const PRICING = "/admin/pricing";
import {
  VERIFY_FLASH_COOKIE,
  VERIFY_FLASH_OPTIONS,
  encodeVerifyFlash,
} from "@/lib/verify-flash";
import { partyEntries } from "@/lib/contract-parties";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function signIn(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  // The admin page they asked for, so signing in returns them to it. Only a
  // path under /admin is accepted; anything else lands on Sessions.
  const next = safeAdminPath(formData.get("next"));

  if (!email || !password) redirect(withNotice(next, "denied"));

  let user: { user_id: string; email: string };
  try {
    user = await edge.adminAuth<{ user_id: string; email: string }>(email, password);
  } catch (err) {
    if (err instanceof EdgeError && err.status === 429) redirect(withNotice(next, "slow"));
    if (err instanceof EdgeError && err.status === 401) redirect(withNotice(next, "denied"));
    // A misconfigured secret and a Supabase outage both land here. Neither is
    // the operator's fault and neither is "wrong password", so they do not get
    // told it was.
    console.error("console sign-in failed:", err);
    redirect(withNotice(next, "broken"));
  }

  const jar = await cookies();
  jar.set(
    CONSOLE_COOKIE,
    mintConsoleCookie({ sub: user.user_id, email: user.email }),
    CONSOLE_COOKIE_OPTIONS
  );

  redirect(next);
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(CONSOLE_COOKIE);
  redirect(SESSIONS);
}



/**
 * Ask TecAssured for a session's menu again.
 *
 * The planner rates a session once, on its first load, and then never again on
 * its own: a session that has already been answered is not re-asked, so a deal
 * that failed cannot turn a reload into a stream of provider calls. That leaves
 * recovery to a person, which is what this is.
 *
 * Use it after fixing whatever stopped the rate: an engine size entered, a body
 * type mapped, the deal corrected in the CRM. A success replaces the row and the
 * customer's next page load shows the menu.
 */
export async function rateSession(formData: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect(SESSIONS);

  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));

  try {
    await edge.adminRate<{ product_count?: number }>(sessionId);
  } catch (err) {
    // fni-rate-vehicle has already recorded the Failed row and its reason, so
    // the row in the list will say what went wrong. Nothing to add here beyond
    // a server-side log.
    console.error(`console re-rate failed for ${sessionId}:`, err);
  }

  // The Rating column is the feedback either way: it shows the new state and,
  // on a failure, the new reason.
  revalidatePath(SESSIONS);
  redirect(SESSIONS);
}


/**
 * Save the dealer group name and the copy that uses it.
 *
 * The Edge Function is the one that validates: it refuses a placeholder the
 * sentence does not have, and it treats a blank wording as "revert to the
 * platform default" by deleting this tenant's row. Its message is passed
 * straight back rather than reworded, because it says exactly what is wrong and
 * a second wording of the same problem is one more thing to keep in step.
 */
export async function saveSettings(formData: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect(WORDING);

  const name = String(formData.get("dealer_group_display_name") ?? "");

  // Sent as a nested object so one form can carry several templates later
  // without the action learning about each one.
  const templates: Record<string, string> = {};
  for (const [field, value] of formData.entries()) {
    if (field.startsWith("template:")) {
      templates[field.slice("template:".length)] = String(value);
    }
  }

  try {
    await edge.adminSaveSettings({
      dealer_group_display_name: name,
      ...(Object.keys(templates).length > 0 ? { templates } : {}),
    });
  } catch (err) {
    if (err instanceof EdgeError && err.status === 400) {
      const detail =
        typeof (err.body as { error?: unknown } | undefined)?.error === "string"
          ? String((err.body as { error: string }).error)
          : "That could not be saved.";
      redirect(`${WORDING}?refused=${encodeURIComponent(detail.slice(0, 300))}`);
    }
    console.error("console settings save failed:", err);
    redirect(withNotice(WORDING, "savefailed"));
  }

  revalidatePath(WORDING);
  redirect(withNotice(WORDING, "saved"));
}


// ── Pricing ─────────────────────────────────────────────────────────────
//
// Three writes: save one rule, delete one rule, copy a scope's rules. Every check
// that can refuse them runs in fni-admin-settings, which says in plain English
// what is wrong; that sentence comes back on the page as it is. The browser
// never writes a rule: these actions send the form to the function, with the
// signed-in operator's email, and the function writes.

/** "all", or a store id. Anything else is All stores. */
function pricingScope(formData: FormData, key = "scope"): string {
  const v = String(formData.get(key) ?? "");
  return UUID_RE.test(v) ? v : "all";
}

function pricingPage(scope: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(scope === "all" ? extra : { scope, ...extra });
  const s = q.toString();
  return s ? `${PRICING}?${s}` : PRICING;
}

/** The function's own sentence for a refusal, or null if it was not one. */
function refusal(err: unknown): string | null {
  if (!(err instanceof EdgeError) || err.status !== 400) return null;
  const detail = (err.body as { error?: unknown } | undefined)?.error;
  return typeof detail === "string" ? detail.slice(0, 600) : "That could not be saved.";
}

async function pricingWrite(
  formData: FormData,
  body: Record<string, unknown>,
  done: string
): Promise<never> {
  const operator = await currentOperator();
  if (!operator) redirect(PRICING);

  const scope = pricingScope(formData);
  try {
    // operator_id: pricing and its band are managers only (migration 0045).
    await edge.adminSavePricing({ ...body, scope, updated_by: operator.email, operator_id: operator.sub });
  } catch (err) {
    const why = refusal(err);
    if (why !== null) redirect(pricingPage(scope, { refused: why }));
    console.error("console pricing write failed:", err);
    redirect(pricingPage(scope, { savefailed: "1" }));
  }

  revalidatePath(PRICING);
  redirect(pricingPage(scope, { [done]: "1" }));
}

/** Add a rule, or save changes to one. */
export async function savePricingRule(formData: FormData): Promise<void> {
  const ruleId = String(formData.get("rule_id") ?? "");
  await pricingWrite(
    formData,
    {
      action: "save",
      rule_id: UUID_RE.test(ruleId) ? ruleId : null,
      rule: {
        product_code: String(formData.get("product_code") ?? ""),
        cost_floor: String(formData.get("cost_floor") ?? ""),
        cost_ceiling: String(formData.get("cost_ceiling") ?? ""),
        markup_percent: String(formData.get("markup_percent") ?? ""),
        markup_min_dollars: String(formData.get("markup_min_dollars") ?? ""),
        markup_max_dollars: String(formData.get("markup_max_dollars") ?? ""),
        round_to: String(formData.get("round_to") ?? ""),
        max_markup_percent: String(formData.get("max_markup_percent") ?? ""),
        max_markup_dollars: String(formData.get("max_markup_dollars") ?? ""),
        active: formData.get("active") === "on",
      },
    },
    "saved"
  );
}

export async function deletePricingRule(formData: FormData): Promise<void> {
  await pricingWrite(
    formData,
    { action: "delete", rule_id: String(formData.get("rule_id") ?? "") },
    "deleted"
  );
}

/** Copy this scope's rules to a scope that has none. */
export async function copyPricingRules(formData: FormData): Promise<void> {
  await pricingWrite(
    formData,
    { action: "copy", to_scope: pricingScope(formData, "to_scope") },
    "copied"
  );
}


// ── The Verify step ───────────────────────────────────────────────────────
//
// Five buttons, one endpoint. Each redirects back to the same screen, because
// the screen is the feedback: the sheet re-renders with new values, new sources
// and a Confirm button that is enabled or is not. Confirm and Continue is the
// exception: it leaves for the presentation, which is the whole point of it.
//
// ── No sign-in here (2026-09-27) ─────────────────────────────────────────
// These used to re-check the console operator and bounce to the sign-in page.
// They no longer do. The CRM button opens this screen directly and the thing
// that protects it is the same thing that protects the presentation: holding an
// unguessable session link.
//
// What did NOT move: the session browser and the settings screen still require
// a sign-in. They list twenty-five deals' worth of buyer names, addresses and
// phone numbers across the whole store, which is a different exposure from one
// deal to whoever was sent that deal's link.
//
// Voiding a contract and clearing Submit Status Unknown also still require a
// sign-in, and they are further down this file. They reach TecAssured and undo
// real paperwork, and they are not part of the flow being simplified.

/** Remember who is at this desk. Attribution, not authorisation: see lib/checker.ts. */
export async function setCheckerName(formData: FormData): Promise<void> {
  const sessionId = String(formData.get("session_id") ?? "");
  const name = cleanCheckerName(formData.get("checker_name"));

  const jar = await cookies();
  if (name === "") jar.delete(CHECKER_COOKIE);
  else jar.set(CHECKER_COOKIE, name, CHECKER_COOKIE_OPTIONS);

  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));
  revalidatePath(`/details/${sessionId}`);
  return backToVerify(sessionId, name === "" ? "whocleared" : "who");
}

/**
 * Where a verify action lands, with a message if it has one to pass on.
 *
 * The message goes in a short-lived cookie and the URL stays clean. It used to
 * be `?refused=<the endpoint's whole sentence>`, which put provider errors and
 * contract numbers in the address bar in front of a customer and into anything
 * the link was pasted into. See lib/verify-flash.ts.
 *
 * Not `never` any more, because setting a cookie has to be awaited before the
 * redirect throws. Callers await it and then return.
 */
async function backToVerify(
  sessionId: string,
  code: string | null = null,
  detail: string | null = null
): Promise<never> {
  if (code !== null) {
    const jar = await cookies();
    jar.set(VERIFY_FLASH_COOKIE, encodeVerifyFlash(code, detail), VERIFY_FLASH_OPTIONS);
  }
  redirect(`/details/${sessionId}`);
}

async function verifyAction(
  formData: FormData,
  build: (sessionId: string) => Record<string, unknown>,
  onOk: string | null = null
): Promise<never> {
  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));

  try {
    await edge.verifyAction<unknown>(build(sessionId));
  } catch (err) {
    // The Edge Function's own message, not a reworded one. It names the field
    // that is missing or quotes the provider, which is exactly what the person
    // standing at the screen needs, and a second wording of the same problem is
    // one more thing to keep in step.
    const message =
      err instanceof EdgeError ? err.message : "Something went wrong. Try again.";
    console.error(`console verify action failed for ${sessionId}:`, err);
    return backToVerify(sessionId, "refused", message);
  }

  revalidatePath(`/details/${sessionId}`);
  revalidatePath(SESSIONS);
  return backToVerify(sessionId, onOk);
}

/**
 * Save the sheet.
 *
 * Every editable field, not a hand-written list of three. The form posts whatever
 * inputs the sheet rendered, and the sheet renders an input for exactly the
 * fields the Edge Function will accept, so the two cannot drift: a field that
 * closes -- APR on a cash deal -- stops being rendered and stops being posted.
 *
 * session_id is skipped because it is the address, not a value, and a blank box
 * is sent through as an empty string on purpose: that is how a person puts the
 * original value back.
 */
export async function saveVerifyFields(formData: FormData): Promise<void> {
  const who = await checkerFor(formData);
  const sessionId = String(formData.get("session_id") ?? "");
  if (who === "") {
    // The endpoint refuses an unnamed edit, and it is right to. Said here so the
    // person gets the sentence they need rather than the endpoint's.
    if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));
    return backToVerify(sessionId, "needname");
  }

  // Only the known rating inputs. A Server Action form also carries React's own
  // hidden $ACTION_ID field, and forwarding it made the endpoint refuse the
  // whole save with "These fields cannot be edited here: $ACTION_ID_...". See
  // lib/verify-fields.ts. session_id is the address and checker_name is who is
  // typing; neither is a value on the deal, and neither is in the list.
  const entries = ratingInputsFrom(formData.entries());

  await verifyAction(
    formData,
    (session_id) => ({
      session_id,
      action: "save",
      entries,
      // An edit can move a price, so it carries a name the same way a
      // verification does.
      edited_by: who,
    }),
    "saved"
  );
}

/**
 * "Discard my edits and reload from CRM."
 *
 * Drops the overrides of fields the CRM carries and re-pulls the deal. Engine
 * size, factory warranty and fuel type survive, because the CRM does not carry
 * them and there would be nothing to reload them from.
 */
export async function discardEdits(formData: FormData): Promise<void> {
  await verifyAction(
    formData,
    (session_id) => ({ session_id, action: "discard_edits" }),
    "discarded"
  );
}

/** Ask TecAssured what the VIN is. Fills engine size and fuel type. */
export async function decodeVin(formData: FormData): Promise<void> {
  // fni-vin-decode rather than a verify action. It was the only part of this
  // screen that calls the provider, and keeping it on fni-session-verify made a
  // sheet endpoint bundle the entire TecAssured client. It returns the decode
  // rather than the sheet, so the sheet is re-read the way any page load reads it.
  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));

  try {
    await edge.vinDecode<unknown>(sessionId);
  } catch (err) {
    const message =
      err instanceof EdgeError ? err.message : "Something went wrong. Try again.";
    console.error(`vin decode failed for ${sessionId}:`, err);
    return backToVerify(sessionId, "refused", message);
  }

  revalidatePath(`/details/${sessionId}`);
  return backToVerify(sessionId, "decoded");
}

/** Re-pull the deal's rating inputs from the CRM. */
export async function refreshFromCrm(formData: FormData): Promise<void> {
  await verifyAction(formData, (session_id) => ({ session_id, action: "refresh" }), "refreshed");
}

// ── Who goes on the contracts ─────────────────────────────────────────────
//
// The buyer, co-buyer and lienholder panels on Details. Signed-in operators
// only: these are names, addresses and phone numbers, and the page shows them
// only to an operator. Each change is a staff edit with the person's name on
// it (supabase/functions/_shared/contract-parties.ts).

async function partyAction(
  formData: FormData,
  body: (sessionId: string) => Record<string, unknown>,
  onOk: string
): Promise<void> {
  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));
  const operator = await currentOperator();
  if (!operator) return backToVerify(sessionId, "refused", "Sign in to change who goes on the contracts.");
  const who = (await checkerFor(formData)) || operator.email;
  await verifyAction(formData, (session_id) => ({ ...body(session_id), edited_by: who }), onOk);
}

export async function savePartyFields(formData: FormData): Promise<void> {
  await partyAction(formData, (session_id) => ({ session_id, action: "party_save", entries: partyEntries(formData) }), "partysaved");
}

export async function removeParty(formData: FormData): Promise<void> {
  const party = String(formData.get("party") ?? "");
  if (formData.get("confirm") !== "1") {
    const sessionId = String(formData.get("session_id") ?? "");
    if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));
    return backToVerify(sessionId, "refused", `Tick the box to confirm removing the ${party.toLowerCase()}.`);
  }
  await partyAction(formData, (session_id) => ({ session_id, action: "party_remove", party }), "partyremoved");
}

export async function restoreParty(formData: FormData): Promise<void> {
  const party = String(formData.get("party") ?? "");
  await partyAction(formData, (session_id) => ({ session_id, action: "party_restore", party }), "partyrestored");
}

export async function keepStaffValue(formData: FormData): Promise<void> {
  const key = String(formData.get("key") ?? "");
  await partyAction(formData, (session_id) => ({ session_id, action: "party_keep_staff", key }), "partykept");
}

export async function useCrmValue(formData: FormData): Promise<void> {
  const key = String(formData.get("key") ?? "");
  await partyAction(formData, (session_id) => ({ session_id, action: "party_use_crm", key }), "partycrm");
}

/**
 * The coverage level each conventional menu column starts at on this deal,
 * set by a manager before presenting. A level the same as the template's is
 * not kept, so the template still decides it.
 */
export async function saveMenuLevels(formData: FormData): Promise<void> {
  const levels = Object.fromEntries(
    [1, 2, 3, 4, 5]
      .filter((n) => formData.has(`level_${n}`))
      .map((n) => [String(n), String(formData.get(`level_${n}`) ?? "")])
  );
  await verifyAction(formData, (session_id) => ({ session_id, action: "menu_levels", levels }), "menulevels");
}

/**
 * Verify, then rate.
 *
 * In that order and not the other way round: the verification is recorded first,
 * so a provider having a bad afternoon cannot cost a person credit for work they
 * actually did. A failed rate leaves the session Verified with a Failed rating,
 * which is a state the console can show and a person can retry.
 */
export async function verifyAndRate(formData: FormData): Promise<void> {
  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));

  const who = await checkerFor(formData);
  if (who === "") return backToVerify(sessionId, "needname");

  // Typing the name and pressing Confirm in one go should not make the person
  // type it again on the next deal.
  const jar = await cookies();
  jar.set(CHECKER_COOKIE, who, CHECKER_COOKIE_OPTIONS);

  try {
    await edge.verifyAction<unknown>({
      session_id: sessionId,
      action: "verify",
      // Whoever said they were checking it. The gate refuses an unnamed
      // verification, because a verification with nobody's name on it is not one.
      verified_by: who,
    });
  } catch (err) {
    const message =
      err instanceof EdgeError ? err.message : "Something went wrong. Try again.";
    console.error(`console verify failed for ${sessionId}:`, err);
    return backToVerify(sessionId, "refused", message);
  }

  // Now the rating. Its own failure is also recorded on the session by
  // fni-rate-vehicle and shows in the Rating row. The reason is kept here too,
  // so the person who pressed the button is told in words what happened.
  let rated = false;
  let reason: string | null = null;
  let warning: string | null = null;
  try {
    const result = await edge.adminRate<{ product_count?: number; warning?: string | null }>(sessionId);
    if ((result?.product_count ?? 0) > 0) {
      rated = true;
      // A provider failed and its last good offers were kept: said in words.
      warning = typeof result?.warning === "string" ? result.warning : null;
    } else {
      reason = "No provider offered any plans for this deal.";
    }
  } catch (err) {
    console.error(`rate after verify failed for ${sessionId}:`, err);
    reason = err instanceof EdgeError ? err.message : "The rate did not come back.";
  }

  revalidatePath(`/details/${sessionId}`);
  revalidatePath(`/plan/${sessionId}`);
  revalidatePath(SESSIONS);

  // ── Back to this screen, not into the presentation ─────────────────────
  //
  // The presentation opens in its own tab, from the Open presentation button
  // this screen shows once the session is verified. Verify stays open here for
  // changes. A tab opened that way has no history, so the customer cannot press
  // Back into the staff screen, and the planner has no link of any kind to it.
  //
  // Even when the rate failed, this comes back with a message rather than an
  // error page. The presentation can still be opened: the planner has a neutral
  // screen for a session with no rate, and that is what the customer sees.
  return backToVerify(sessionId, rated ? (warning ? "ratedkept" : "rated") : "notrated", warning ?? reason);
}

/**
 * Void a contract at TecAssured, then here.
 *
 * On the verify screen rather than the planner, because it is not a customer's
 * decision. A customer who changes their mind after signing produces a refusal
 * from fni-contract-submit naming the contract to void, and this is where that
 * gets done.
 */
export async function voidContract(formData: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect(SESSIONS);

  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));

  const contractNumber = String(formData.get("contract_number") ?? "").trim();
  if (!contractNumber) return backToVerify(sessionId, "refused", "No contract number was given.");
  const reason = String(formData.get("void_reason") ?? "").trim();
  if (!reason) return backToVerify(sessionId, "refused", "Say why this contract is being voided.");
  if (formData.get("confirm") !== "on") {
    return backToVerify(sessionId, "refused", "Tick the box to confirm. Voiding cancels the contract with the provider.");
  }

  let message: string | null = null;
  try {
    const done = await edge.contractVoid<{ message?: string }>({
      session_id: sessionId,
      action: "Void",
      contract_number: contractNumber,
      staff_email: operator.email,
      // For the event if this void reopens the session.
      staff_initials: initialsFor(operator.email),
      void_reason: reason,
    });
    message = done.message ?? null;
  } catch (err) {
    const message =
      err instanceof EdgeError ? err.message : "Something went wrong. Try again.";
    console.error(`void failed for ${sessionId} / ${contractNumber}:`, err);
    return backToVerify(sessionId, "refused", message);
  }

  revalidatePath(`/details/${sessionId}`);
  revalidatePath(SESSIONS);
  return message ? backToVerify(sessionId, "contracts", message) : backToVerify(sessionId, "voided", contractNumber);
}

/**
 * Submit what the customer chose in the planner, as saved, to the provider.
 * Signed in, like Void: it creates real paperwork (on the QA server only,
 * while DocuRide is being tested). fni-contract-submit's lock refuses a second
 * submit for the session while one is running.
 */
/** The provider as the start of a sentence, by its record's name. */
function providerSays(name: string | undefined): string {
  const v = name?.trim() || "the provider";
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/**
 * Rate again, from the Rating line on Details: the same rating staff run,
 * with the session's current inputs, any time. Each selection the fresh
 * offer matches to the cent is kept on its fresh rate; any other is marked
 * out of date and listed under Rating (fni-rate-vehicle, rate_again). Never
 * submits. A rating error stays on the page behind Show details.
 */
export async function rateAgain(formData: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect(SESSIONS);
  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));

  let done: { outcome?: string; product_count?: number; lines?: unknown[] };
  try {
    done = await edge.rate<typeof done>({
      session_id: sessionId,
      rate_again: true,
      // For "Rated again by": the person's initials, or System.
      rated_by: initialsFor(operator.email),
    });
  } catch (err) {
    console.error(`rate again failed for ${sessionId}:`, err);
    revalidatePath(`/details/${sessionId}`);
    return backToVerify(
      sessionId,
      "rateagainfailed",
      err instanceof EdgeError ? err.message : "The deal could not be rated again. Try again."
    );
  }
  revalidatePath(`/details/${sessionId}`);
  revalidatePath(`/plan/${sessionId}`);
  revalidatePath(SESSIONS);
  if (done.outcome === "changed") return backToVerify(sessionId, "ratedagainheld");
  const count = done.product_count ?? 0;
  return backToVerify(
    sessionId,
    "ratedagain",
    `Rated again: ${count} ${count === 1 ? "product" : "products"}.` +
      ((done.lines?.length ?? 0) > 0 ? " Every selected product still matches to the cent, so the selections are kept." : "")
  );
}

/**
 * Submit contracts, when a voided contract has spent a rate the submit would
 * send (supabase/functions/_shared/spent-rates.ts). Rates the deal again the
 * way staff do, and moves the selections onto the fresh rates only when every
 * price is unchanged to the cent. Never submits: the page comes back with the
 * confirmation open, saying what the refresh found. A refresh that fails
 * leaves the provider's error on the page, behind Show details.
 */
export async function refreshSpentRates(formData: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect(SESSIONS);
  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));

  let outcome: string | undefined;
  try {
    const done = await edge.rate<{ outcome?: string }>({
      session_id: sessionId,
      refresh_spent: true,
      // For the session event: the person's initials, or System.
      refreshed_by: initialsFor(operator.email),
    });
    outcome = done.outcome;
  } catch (err) {
    console.error(`rating refresh failed for ${sessionId}:`, err);
    revalidatePath(`/details/${sessionId}`);
    return backToVerify(
      sessionId,
      "refreshfailed",
      err instanceof EdgeError ? err.message : "The rating could not be refreshed, so nothing was submitted. Try again."
    );
  }
  revalidatePath(`/details/${sessionId}`);
  return backToVerify(sessionId, outcome === "unchanged" ? "spentrefreshed" : outcome === "held" ? "spentheld" : "submitready");
}

export async function submitContracts(formData: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect(SESSIONS);
  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));

  let detail: string;
  let partial = false;
  try {
    const done = await edge.submit<{
      contract_count?: number;
      contracts?: { contract_number: string | null }[];
      already_submitted?: boolean;
      /** Product by product: created, refused, or not known. */
      message?: string;
      partial?: boolean;
      /** The provider record's name. */
      provider_name?: string;
    }>({
      session_id: sessionId,
      use_saved_selections: true,
      // For the session event if a test session submits on an out-of-date rating.
      submitted_by: initialsFor(operator.email),
      // Ticked when contract details were changed on Details: the person
      // confirms DX1 matches. The Edge Function refuses without it then.
      ...(formData.get("dx1_confirmed") === "1"
        ? { dx1_confirmed: true, confirmed_by: (await checkerFor(formData)) || operator.email }
        : {}),
    });
    const numbers = (done.contracts ?? []).map((c) => c.contract_number ?? "no number").join(", ");
    // Some went through and some did not: the endpoint's own lines say which.
    partial = done.partial === true;
    detail = done.already_submitted
      ? `These products were already submitted: ${numbers}. Nothing new was sent.`
      : partial && done.message
        ? `${done.message} Get the document for each contract created.`
        : `Submitted. ${providerSays(done.provider_name)} returned ${done.contract_count ?? 0} ${done.contract_count === 1 ? "contract" : "contracts"}: ${numbers}. Get each document next.`;
  } catch (err) {
    console.error(`submit failed for ${sessionId}:`, err);
    const message = err instanceof EdgeError ? err.message : "Something went wrong. Try again.";
    return backToVerify(sessionId, "refused", message);
  }
  revalidatePath(`/details/${sessionId}`);
  revalidatePath(SESSIONS);
  return backToVerify(sessionId, partial ? "refused" : "contracts", detail);
}

/**
 * Move the deal's held documents into its Deal Jacket, the same call the CRM
 * makes once DocuRide DC has made the deal's folders. For testing by hand.
 */
export async function moveDocumentsToDealJacket(formData: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect(SESSIONS);
  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));

  let done: { message?: string; files?: { file_name: string | null; outcome: string }[] };
  try {
    done = await edge.documentsToDealJacket({ session_id: sessionId });
  } catch (err) {
    console.error(`move to Deal Jacket failed for ${sessionId}:`, err);
    return backToVerify(sessionId, "refused", err instanceof EdgeError ? err.message : "Something went wrong. Try again.");
  }
  revalidatePath(`/details/${sessionId}`);
  const notMoved = (done.files ?? []).filter((f) => !/^(Saved to Deal Jacket|Already in the Deal Jacket)/.test(f.outcome));
  const detail =
    (done.message ?? "Done.") + (notMoved.length > 0 ? ` Not moved: ${notMoved.map((f) => f.outcome).join(" ")}` : "");
  return backToVerify(sessionId, notMoved.length > 0 ? "refused" : "contracts", detail);
}

/** Pull one contract's document from the provider and save it to the Deal Jacket. */
export async function getContractDocument(formData: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect(SESSIONS);
  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));
  const contractNumber = String(formData.get("contract_number") ?? "").trim();
  if (!contractNumber) return backToVerify(sessionId, "refused", "No contract number was given.");

  let done: {
    documents?: {
      file_name: string | null;
      workdrive_file_id: string | null;
      page_count: number | null;
      document_status: string | null;
      error: string | null;
    }[];
  };
  try {
    done = await edge.documents({ session_id: sessionId, contract_number: contractNumber });
  } catch (err) {
    console.error(`document failed for ${sessionId} / ${contractNumber}:`, err);
    return backToVerify(sessionId, "refused", err instanceof EdgeError ? err.message : "Something went wrong. Try again.");
  }
  const doc = done.documents?.[0];
  revalidatePath(`/details/${sessionId}`);
  if (!doc || (doc.error && !doc.document_status)) {
    return backToVerify(sessionId, "refused", doc?.error ?? `The document for ${contractNumber} was not saved. Try again.`);
  }
  const pages = `${doc.page_count ?? "?"} ${doc.page_count === 1 ? "page" : "pages"}`;
  if (doc.workdrive_file_id) {
    return backToVerify(sessionId, "contracts", `Saved the document for ${contractNumber} to the Deal Jacket (${pages}).`);
  }
  return backToVerify(
    sessionId,
    doc.error ? "refused" : "contracts",
    doc.error ??
      `Got the document for ${contractNumber} (${pages}). It is held in DocuRide and waiting for the deal's Deal Jacket.`
  );
}

// ── OEM contracts, recorded by staff (multi-provider Part 7) ─────────────
//
// A Price Sheet provider has no API. Staff write its contract on the OEM's own
// system, then record it here with the signed document, which the browser puts
// straight into the private oem-contracts bucket. Nothing here calls
// TecAssured or any other provider. Signed in, like Void: it is paperwork.

/** A one-time upload URL for a signed OEM contract. */
export async function oemContractUploadUrl(
  sessionId: string,
  fileName: string
): Promise<{ document_path: string; signed_url: string } | { error: string }> {
  const operator = await currentOperator();
  if (!operator) return { error: "Sign in again to upload." };
  if (!UUID_RE.test(sessionId)) return { error: "That deal could not be found." };
  try {
    return await edge.oemContractWrite<{ document_path: string; signed_url: string }>({
      action: "upload_url",
      session_id: sessionId,
      file_name: fileName,
    });
  } catch (err) {
    return {
      error: err instanceof EdgeError && err.status < 500 ? err.message : "An upload could not be started just now. Try again shortly.",
    };
  }
}

async function oemWrite(fd: FormData, build: (by: string) => Record<string, unknown>): Promise<never> {
  const operator = await currentOperator();
  if (!operator) redirect(SESSIONS);
  const sessionId = String(fd.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));
  let message = "Done.";
  try {
    const done = await edge.oemContractWrite<{ message?: string }>({
      session_id: sessionId,
      ...build(operator.email),
      // For the event if a void reopens the session.
      staff_initials: initialsFor(operator.email),
    });
    message = done.message ?? message;
  } catch (err) {
    console.error(`OEM contract write failed for ${sessionId}:`, err);
    return backToVerify(sessionId, "refused", err instanceof EdgeError ? err.message : "Something went wrong. Try again.");
  }
  revalidatePath(`/details/${sessionId}`);
  return backToVerify(sessionId, "oem", message);
}

/** Record an OEM contract whose signed document is already uploaded. */
export async function recordOemContract(fd: FormData): Promise<void> {
  await oemWrite(fd, (by) => ({
    action: "record",
    selected_product_id: String(fd.get("selected_product_id") ?? ""),
    contract_number: String(fd.get("contract_number") ?? ""),
    document_path: String(fd.get("document_path") ?? ""),
    recorded_by: by,
  }));
}

/** Void a recorded OEM contract here. It must also be voided on the OEM's system. */
export async function voidOemContract(fd: FormData): Promise<void> {
  await oemWrite(fd, (by) => ({
    action: "void",
    contract_number: String(fd.get("contract_number") ?? ""),
    void_reason: String(fd.get("void_reason") ?? ""),
    voided_by: by,
  }));
}

/**
 * Say that TecAssured has been checked.
 *
 * The only way out of Submit Status Unknown, and it is a person's word that they
 * looked. Nothing times out of that state on its own, because the alternative is
 * guessing that no contract was created, and that guess is how a deal ends up
 * with two.
 */
export async function clearSubmitUnknown(formData: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect(SESSIONS);

  const sessionId = String(formData.get("session_id") ?? "");
  if (!UUID_RE.test(sessionId)) redirect(withNotice(SESSIONS, "bad"));

  try {
    await edge.contractVoid<unknown>({
      session_id: sessionId,
      action: "Clear Submit Status Unknown",
      staff_email: operator.email,
      note: String(formData.get("note") ?? "").trim() || undefined,
    });
  } catch (err) {
    const message =
      err instanceof EdgeError ? err.message : "Something went wrong. Try again.";
    console.error(`clear submit state failed for ${sessionId}:`, err);
    return backToVerify(sessionId, "refused", message);
  }

  revalidatePath(`/details/${sessionId}`);
  revalidatePath(SESSIONS);
  return backToVerify(sessionId, "cleared");
}

// ── Providers, Menus and Price sheets (multi-provider Part 6) ────────────
//
// The same shape as Pricing: each action checks the operator, sends the write
// to its function with the operator's email, and comes back to the page with
// either the function's own sentence for a refusal or a saved notice. Nothing
// here deletes: providers and menus are switched off, rates left out, sheets
// retired.

const PROVIDERS = "/admin/providers";
const STORES = "/admin/stores";
const MENUS = "/admin/menus";
const SHEETS = "/admin/price-sheets";

/** A path with query parameters added, keeping any it already had. */
function withQuery(path: string, add: Record<string, string>): string {
  const [base, query = ""] = path.split("?");
  const q = new URLSearchParams(query);
  for (const [k, v] of Object.entries(add)) q.set(k, v);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** The function's own sentence for a refusal (400, 404 or 409), or null. */
function refusedWith(err: unknown): string | null {
  if (!(err instanceof EdgeError) || ![400, 404, 409].includes(err.status)) return null;
  const detail = (err.body as { error?: unknown } | undefined)?.error;
  return typeof detail === "string" ? detail.slice(0, 600) : "That could not be saved.";
}

async function adminWrite(
  back: string,
  // `operatorId` lets the Edge Function check a manager-only change (migration 0045).
  write: (by: string, operatorId: string) => Promise<unknown>,
  done: string,
  next?: (result: unknown) => string
): Promise<never> {
  const operator = await currentOperator();
  if (!operator) redirect(back);

  let result: unknown;
  try {
    result = await write(operator.email, operator.sub);
  } catch (err) {
    const why = refusedWith(err);
    if (why !== null) redirect(withQuery(back, { refused: why }));
    console.error(`admin write failed (${back}):`, err);
    redirect(withQuery(back, { savefailed: "1" }));
  }
  revalidatePath(back.split("?")[0]);
  redirect(next ? next(result) : withQuery(back, { [done]: "1" }));
}

const field = (fd: FormData, k: string) => String(fd.get(k) ?? "");

// ── Stores ──

/** One store's time zone, which decides when its day ends. */
export async function saveStoreTimeZone(fd: FormData): Promise<void> {
  await adminWrite(STORES, (by) =>
    edge.adminSaveStore({ store_id: field(fd, "store_id"), time_zone: field(fd, "time_zone"), updated_by: by }), "saved");
}

// ── Providers ──

export async function saveProvider(fd: FormData): Promise<void> {
  await adminWrite(PROVIDERS, (by) =>
    edge.adminSaveProviders({
      action: "save",
      provider_id: field(fd, "provider_id"),
      name: field(fd, "name"),
      makes: field(fd, "makes"),
      notes: field(fd, "notes"),
      document_prefix: field(fd, "document_prefix"),
      active: fd.get("active") === "on",
      updated_by: by,
    }), "saved");
}

export async function addProvider(fd: FormData): Promise<void> {
  await adminWrite(PROVIDERS, (by) =>
    edge.adminSaveProviders({
      action: "add",
      name: field(fd, "name"),
      makes: field(fd, "makes"),
      notes: field(fd, "notes"),
      document_prefix: field(fd, "document_prefix"),
      updated_by: by,
    }), "added");
}

export async function setProviderStores(fd: FormData): Promise<void> {
  await adminWrite(PROVIDERS, (by) =>
    edge.adminSaveProviders({
      action: "stores",
      provider_id: field(fd, "provider_id"),
      store_ids: fd.getAll("store_ids").map(String),
      updated_by: by,
    }), "saved");
}

// ── Product wording ──

export async function saveWording(fd: FormData): Promise<void> {
  const providerId = field(fd, "provider_id");
  const productId = field(fd, "product_id");
  await adminWrite(`${PROVIDERS}/wording?provider=${providerId}&product=${productId}`, (by) =>
    edge.adminSaveWording({
      action: "save",
      product_id: productId,
      display_name: field(fd, "display_name"),
      goal: field(fd, "goal"),
      what_it_accomplishes: field(fd, "what_it_accomplishes"),
      what_it_covers: field(fd, "what_it_covers"),
      coverage_duration: field(fd, "coverage_duration"),
      what_it_excludes: field(fd, "what_it_excludes"),
      deductible_note: field(fd, "deductible_note"),
      how_to_use: field(fd, "how_to_use"),
      transferable: field(fd, "transferable"),
      transfer_note: field(fd, "transfer_note"),
      future_value_note: field(fd, "future_value_note"),
      full_terms_url: field(fd, "full_terms_url"),
      active: fd.get("active") === "on",
      updated_by: by,
    }), "saved");
}

// ── Menus ──

export async function saveTemplate(fd: FormData): Promise<void> {
  const templateId = field(fd, "template_id");
  await adminWrite(
    templateId ? `${MENUS}?template=${templateId}` : MENUS,
    (by) =>
      edge.adminSaveTemplates({
        action: "save",
        template_id: templateId || undefined,
        name: field(fd, "name"),
        description: field(fd, "description"),
        store_ids: fd.getAll("store_ids").map(String),
        deal_types: fd.getAll("deal_types").map(String),
        vehicle_types: fd.getAll("vehicle_types").map(String),
        conditions: fd.getAll("conditions").map(String),
        makes: field(fd, "makes"),
        priority: field(fd, "priority"),
        active: fd.get("active") === "on",
        updated_by: by,
      }),
    "saved",
    (r) => `${MENUS}?template=${(r as { template_id: string }).template_id}&saved=1`
  );
}

/**
 * A slot's products, in the order typed beside them. A product with no number
 * is not in the slot. Ties keep the catalog's order.
 */
function slotProducts(fd: FormData): string[] {
  return [...fd.entries()]
    .filter(([k, v]) => k.startsWith("order_") && String(v).trim() !== "")
    .map(([k, v], i) => ({ id: k.slice(6), n: Number(String(v).trim()), i }))
    .filter((p) => Number.isFinite(p.n))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((p) => p.id);
}

export async function saveSlot(fd: FormData): Promise<void> {
  const templateId = field(fd, "template_id");
  const slotId = field(fd, "slot_id");
  await adminWrite(`${MENUS}?template=${templateId}`, (by) =>
    edge.adminSaveTemplates({
      action: slotId ? "save_slot" : "add_slot",
      template_id: templateId,
      slot_id: slotId || undefined,
      title: field(fd, "title"),
      category: field(fd, "category"),
      mode: field(fd, "mode"),
      product_ids: slotProducts(fd),
      updated_by: by,
    }), "saved");
}

export async function moveSlot(fd: FormData): Promise<void> {
  const templateId = field(fd, "template_id");
  await adminWrite(`${MENUS}?template=${templateId}`, (by) =>
    edge.adminSaveTemplates({
      action: "move_slot",
      slot_id: field(fd, "slot_id"),
      direction: field(fd, "direction"),
      updated_by: by,
    }), "moved");
}

/**
 * A menu's conventional columns: up to five rows, a blank name is a column
 * not in use. The Edge Function refuses fewer than two or more than five.
 */
export async function saveMenuColumns(fd: FormData): Promise<void> {
  const templateId = field(fd, "template_id");
  const columns = [1, 2, 3, 4, 5].map((n) => ({
    name: field(fd, `col_${n}_name`),
    preset_categories: fd.getAll(`col_${n}_categories`).map(String),
    starting_level: field(fd, `col_${n}_level`),
  }));
  await adminWrite(`${MENUS}?template=${templateId}`, (by) =>
    edge.adminSaveTemplates({ action: "save_columns", template_id: templateId, columns, updated_by: by }), "saved");
}

/**
 * Menu presets for one template and deal type (Financed or Cash). Managers
 * only: the Edge Function checks, and logs every change with who and when.
 */
export async function saveMenuPresets(fd: FormData): Promise<void> {
  const templateId = field(fd, "template_id");
  const dealType = field(fd, "deal_type") === "Cash" ? "Cash" : "Financed";
  const presets: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (/^p_\d_\d_[a-z]+$/.test(k)) presets[k] = String(v);
  await adminWrite(`${MENUS}?template=${templateId}&presets=${dealType}`, (by, operatorId) =>
    edge.adminSaveTemplates({
      action: "save_presets", template_id: templateId, deal_type: dealType, presets, updated_by: by, operator_id: operatorId,
    }), "saved");
}

// ── Price sheets ──

/**
 * A one-time URL the browser uploads the file to, straight into the private
 * bucket, so a large sheet never passes through this server. Returned, not
 * redirected: the upload form calls this, then submits createPriceSheet.
 */
export async function priceSheetUploadUrl(
  providerId: string,
  fileName: string
): Promise<{ file_path: string; signed_url: string } | { error: string }> {
  const operator = await currentOperator();
  if (!operator) return { error: "Sign in again to upload." };
  try {
    return await edge.priceSheetWrite<{ file_path: string; signed_url: string }>({
      action: "upload_url",
      provider_id: providerId,
      file_name: fileName,
    });
  } catch (err) {
    return { error: refusedWith(err) ?? "An upload could not be started just now. Try again shortly." };
  }
}

/** Record an uploaded sheet, then start reading it. */
export async function createPriceSheet(fd: FormData): Promise<void> {
  const operator = await currentOperator();
  if (!operator) redirect(SHEETS);
  let sheetId = "";
  try {
    const made = await edge.priceSheetWrite<{ sheet: { id: string } }>({
      action: "upload",
      provider_id: field(fd, "provider_id"),
      name: field(fd, "name"),
      effective_from: field(fd, "effective_from"),
      effective_to: field(fd, "effective_to"),
      file_name: field(fd, "file_name"),
      file_path: field(fd, "file_path"),
      uploaded_by: operator.email,
    });
    sheetId = made.sheet.id;
  } catch (err) {
    const why = refusedWith(err);
    redirect(withQuery(SHEETS, why ? { refused: why } : { savefailed: "1" }));
  }

  // Reading starts straight away. A refusal here (no key, say) is recorded on
  // the sheet and shown on its page, so it is not an upload failure.
  try {
    await edge.priceSheetParse({ sheet_id: sheetId, requested_by: operator.email });
  } catch (err) {
    console.error(`price sheet parse did not start for ${sheetId}:`, err);
  }
  revalidatePath(SHEETS);
  redirect(`${SHEETS}/${sheetId}?uploaded=1`);
}

const sheetPage = (fd: FormData) => `${SHEETS}/${field(fd, "sheet_id")}`;

export async function parsePriceSheet(fd: FormData): Promise<void> {
  await adminWrite(sheetPage(fd), (by) =>
    edge.priceSheetParse({ sheet_id: field(fd, "sheet_id"), requested_by: by }), "reading");
}

const RATE_FIELDS = [
  "product_code", "product_name", "family_code", "plan", "category", "makes", "model_contains",
  "year_min", "year_max", "vehicle_types", "conditions", "max_age_years", "max_odometer",
  "engine_cc_min", "engine_cc_max", "max_months_in_service", "term_months", "term_miles",
  "deductible", "dealer_cost", "suggested_retail",
];

export async function editSheetRate(fd: FormData): Promise<void> {
  const fields = Object.fromEntries(RATE_FIELDS.filter((k) => fd.has(k)).map((k) => [k, field(fd, k)]));
  await adminWrite(sheetPage(fd), (by) =>
    edge.priceSheetWrite({ action: "edit_rate", rate_id: field(fd, "rate_id"), edited_by: by, ...fields }), "saved");
}

export async function leaveOutRate(fd: FormData): Promise<void> {
  await adminWrite(sheetPage(fd), (by) =>
    edge.priceSheetWrite({ action: "leave_out", rate_id: field(fd, "rate_id"), reason: field(fd, "reason"), edited_by: by }), "leftout");
}

export async function includeRate(fd: FormData): Promise<void> {
  await adminWrite(sheetPage(fd), (by) =>
    edge.priceSheetWrite({ action: "include", rate_id: field(fd, "rate_id"), edited_by: by }), "saved");
}

export async function publishSheet(fd: FormData): Promise<void> {
  await adminWrite(sheetPage(fd), (by) =>
    edge.priceSheetWrite({ action: "publish", sheet_id: field(fd, "sheet_id"), published_by: by }), "published");
}

export async function retireSheet(fd: FormData): Promise<void> {
  await adminWrite(sheetPage(fd), (by) =>
    edge.priceSheetWrite({ action: "retire", sheet_id: field(fd, "sheet_id"), reason: field(fd, "reason"), retired_by: by }), "retired");
}
