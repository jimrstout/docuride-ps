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
// exactly `/verify/<session_id>`. No JavaScript is involved, which matters: the
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

export const VERIFY_FLASH_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: true,
  path: "/",
  maxAge: 20,
} as const;

/** Keeps a long provider message inside one cookie. */
const MAX_DETAIL = 600;

export interface VerifyFlash {
  code: string;
  detail: string | null;
}

export function encodeVerifyFlash(code: string, detail?: string | null): string {
  const clean = typeof detail === "string" && detail.trim() !== ""
    ? detail.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL)
    : null;
  return encodeURIComponent(JSON.stringify({ c: code, d: clean }));
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
export function flashMessage(flash: VerifyFlash | null): FlashMessage | null {
  if (!flash) return null;

  switch (flash.code) {
    case "refused":
      return { tone: "bad", text: flash.detail ?? "Something went wrong. Try again." };
    case "saved":
      return { tone: "ok", text: "Saved." };
    case "decoded":
      return { tone: "ok", text: "Decoded from the VIN." };
    case "refreshed":
      return { tone: "ok", text: "Re-pulled from CRM." };
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
    case "cleared":
      return { tone: "ok", text: "Recorded as checked. This session can submit again." };
    default:
      return null;
  }
}
