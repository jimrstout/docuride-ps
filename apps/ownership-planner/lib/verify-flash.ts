// lib/verify-flash.ts — the one-shot message after a verify action.
//
// ── Why not the query string ──────────────────────────────────────────────────
// It used to be `?refused=<the endpoint's whole sentence>`, which put a provider
// error, a missing-field list, and sometimes a contract number into a URL. That
// URL then sat in the address bar in front of a customer, went into browser
// history, and got pasted into messages with the refusal still attached. A
// session link is meant to be shareable; an error message is not part of it.
//
// So the message travels in a short-lived cookie instead and the URL stays
// exactly `/details/<session_id>`. No JavaScript is involved, which matters: the
// console works with none.
//
// The cookie expires on its own after twenty seconds rather than being deleted
// on read, because a Server Component cannot clear a cookie while rendering.
// Twenty seconds is long enough to survive the redirect and short enough that
// nobody meets yesterday's message.
//
// No Next imports here, so the encoding and the wording can be tested directly.
// The same split as console-cookie.ts and checker-name.ts.

export const VERIFY_FLASH_COOKIE = "docuride_verify_flash";

/**
 * Said after any change to who goes on the contracts. The same sentence as
 * DX1_REMINDER in lib/contract-parties.ts; a test holds the two together. Not
 * imported, so this file stays free of imports and Node tests can load it.
 */
const DX1_REMINDER =
  "This changes what prints on the service contracts. Make the same change in DX1 so the finance contract matches.";

/**
 * Said after Submit contracts refreshed a spent rating. The same sentences as
 * REFRESHED_NOTE and HELD_MESSAGE in supabase/functions/_shared/spent-rates.ts;
 * a test holds them together.
 */
export const REFRESHED_NOTE =
  "The rating was refreshed because an earlier contract was voided. Prices are unchanged.";
export const HELD_MESSAGE =
  "Prices changed since this deal was rated. Review the products on Details before submitting.";

/** The codes after which the Submit confirmation opens by itself. */
export const SUBMIT_OPEN_CODES = ["submitready", "spentrefreshed", "spentheld"];

export const VERIFY_FLASH_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: true,
  path: "/",
  maxAge: 20,
} as const;

/** Keeps a long provider message inside one cookie. */
const MAX_DETAIL = 1200;

export interface VerifyFlash {
  code: string;
  detail: string | null;
}

export function encodeVerifyFlash(code: string, detail?: string | null): string {
  const clean = typeof detail === "string" && detail.trim() !== ""
    ? detail.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL)
    : null;
  // t makes each message its own, so the page can tell a new "Saved." from the
  // last one and show it where the person is looking (components/Working.tsx).
  return encodeURIComponent(JSON.stringify({ c: code, d: clean, t: Date.now() }));
}

export function decodeVerifyFlash(raw: string | null | undefined): VerifyFlash | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (!parsed || typeof parsed !== "object") return null;
    const code = (parsed as { c?: unknown }).c;
    if (typeof code !== "string" || code === "") return null;
    const detail = (parsed as { d?: unknown }).d;
    return {
      code,
      detail: typeof detail === "string" && detail !== "" ? detail : null,
    };
  } catch {
    return null;
  }
}

export interface FlashMessage {
  tone: "ok" | "bad";
  text: string;
}

/**
 * What the screen says, from the code alone.
 *
 * Here rather than in the page so the wording is testable and there is one copy
 * of it. `refused` carries the endpoint's own sentence as the detail: it names
 * the field that is missing or quotes the provider, which is what the person at
 * the screen needs, and a second wording of the same problem is one more thing
 * to keep in step.
 */
export function flashMessage(
  flash: VerifyFlash | null,
  opts: { ratingShown?: boolean } = {}
): FlashMessage | null {
  if (!flash) return null;

  // The rating's own banner on Details says why, in one plain line with the
  // provider's text behind "Show details" (lib/rating-error.ts). When it is on
  // the page, a rating notice says what happened and leaves the why to it, so
  // the reason is not said twice.
  if (opts.ratingShown && flash.code === "notrated") {
    return {
      tone: "bad",
      text: "Verified, but not rated. You can still open the presentation. The customer will see a neutral message.",
    };
  }
  if (opts.ratingShown && flash.code === "ratedkept") {
    return { tone: "bad", text: "Verified. The re-rate failed, and the last good offers are kept." };
  }

  // The rating's banner holds the provider's error, with Show details and Copy error.
  if (opts.ratingShown && flash.code === "refreshfailed") {
    return { tone: "bad", text: "The rating could not be refreshed, so nothing was submitted. The provider's error is below." };
  }

  switch (flash.code) {
    case "submitready":
      return { tone: "ok", text: "Review the products, then press Confirm Submit." };
    case "spentrefreshed":
      return { tone: "ok", text: REFRESHED_NOTE };
    case "spentheld":
      return { tone: "bad", text: HELD_MESSAGE };
    case "refreshfailed":
      return { tone: "bad", text: flash.detail ?? "The rating could not be refreshed, so nothing was submitted." };
    case "refused":
      return { tone: "bad", text: flash.detail ?? "Something went wrong. Try again." };
    case "rated":
      return {
        tone: "ok",
        text:
          "Verified and rated. Open the presentation when you are ready to show " +
          "the customer.",
      };
    case "ratedkept":
      // A re-rate failed and the last good offers were kept. A warning, not an
      // error: the deal can go ahead on them unless the detail says otherwise.
      return {
        tone: "bad",
        text: `Verified. ${flash.detail ?? "The re-rate failed, and the last good offers are kept."}`,
      };
    case "notrated": {
      const why = flash.detail
        ? /[.!?]$/.test(flash.detail) ? flash.detail : `${flash.detail}.`
        : "The rate did not come back.";
      return {
        tone: "bad",
        text:
          `Verified, but not rated. ${why} You can still open the presentation. ` +
          "The customer will see a neutral message.",
      };
    }
    case "saved":
      return { tone: "ok", text: "Saved." };
    case "decoded":
      return { tone: "ok", text: "Decoded from the VIN." };
    case "refreshed":
      return { tone: "ok", text: "Re-pulled from CRM." };
    case "partysaved":
      return { tone: "ok", text: `Saved. ${DX1_REMINDER}` };
    case "partyremoved":
      return { tone: "ok", text: `Removed. ${DX1_REMINDER}` };
    case "partyrestored":
      return { tone: "ok", text: `Put back as the CRM has it. ${DX1_REMINDER}` };
    case "partykept":
      return { tone: "ok", text: "Kept the staff value." };
    case "partycrm":
      return { tone: "ok", text: `Now using the CRM value. ${DX1_REMINDER}` };
    case "saledatekept":
      return { tone: "ok", text: "Kept the staff sale date." };
    case "saledatecrm":
      return { tone: "ok", text: "Now using the CRM sale date." };
    case "planned":
      return { tone: "ok", text: "Planned sale date saved. This deal stays open until the end of that day." };
    case "plannedcleared":
      return { tone: "ok", text: "Planned sale date cleared. This deal stays open until the end of today." };
    case "needname":
      return {
        tone: "bad",
        text:
          "Put your name in the Checked by box at the top first. It goes on the " +
          "record of what was verified, so it cannot be left blank.",
      };
    case "who":
      return { tone: "ok", text: "Saved. This device will remember it." };
    case "whocleared":
      return { tone: "ok", text: "Name cleared." };
    case "discarded":
      return {
        tone: "ok",
        text:
          "Your edits to the CRM fields are gone and the deal has been re-pulled. " +
          "Engine size, factory warranty and fuel type were kept.",
      };
    case "voided":
      return {
        tone: "ok",
        text: flash.detail
          ? `Contract ${flash.detail} is voided. That product can be submitted ` +
            `again on this deal.`
          : "The contract is voided. That product can be submitted again on this deal.",
      };
    case "contracts":
      // fni-contract-submit's or fni-contract-documents' own account of what happened.
      return { tone: "ok", text: flash.detail ?? "Done." };
    case "oem":
      // fni-oem-contracts' own sentence: what was recorded or voided.
      return { tone: "ok", text: flash.detail ?? "Done." };
    case "cleared":
      return { tone: "ok", text: "Recorded as checked. This session can submit again." };
    default:
      return null;
  }
}
