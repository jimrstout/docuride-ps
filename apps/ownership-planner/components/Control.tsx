"use client";

// components/Control.tsx: the one clickable control in this app.
//
// Every button and every link goes through here, so every one shows that the
// system is working without anybody remembering to add it.
//
// ── Buttons ──────────────────────────────────────────────────────────────
//   type="submit"  sends its form's server action. From the press until the
//                  answer is on the screen it shows a spinner and its working
//                  text, is disabled, and the page (or its panel) is locked
//                  (components/Working.tsx). An error comes back as a plain
//                  line on the page and the entries are put back.
//   onPress        anything else. If it returns a promise (a save, a fetch),
//                  the button is busy until that settles; if it fails, the
//                  button comes back and says what went wrong, in plain
//                  words. If it returns at once (a tab, a toggle), there is
//                  nothing to wait for.
//   A press while busy does nothing.
//
// ── Links ────────────────────────────────────────────────────────────────
//   - the instant it is pressed, it shows a spinner and "Opening...", is
//     disabled, and a bar runs across the top of the window;
//   - it stays that way until the next page's data is drawn, not just until
//     the address changes (components/NavBusy.tsx);
//   - a second press, of it or of any other link, does nothing meanwhile.
//
// A link that opens a new tab (the customer's presentations) stays busy until
// that tab has drawn its page. A link to another site (the CRM, WorkDrive)
// opens normally: there is nothing here that could know when it has loaded.
// A press with a modifier key or the middle button opens a new tab the
// browser's way, and the page here does not wait for it.
//
// test/controls-enforced.test.mjs fails the build if a link or button
// anywhere else in the app is made without this.

import Link from "next/link";
import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { endNav, pathOf, startNav, useNavBusy } from "@/components/NavBusy";
import { useWorking, Working } from "@/components/Working";
import { OPENING } from "@/lib/nav-busy";
import { plainError, WORKING } from "@/lib/control";
import type { WorkingScope } from "@/lib/working";

type AnchorAttrs = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick" | "target" | "rel">;

export interface ControlLinkProps extends AnchorAttrs {
  /** Where it goes. A path in this app, or a full address on another site. */
  href: string;
  children: React.ReactNode;
  /** Open in a new tab, with no handle back to this one (rel="noopener"). */
  newTab?: boolean;
  /** What it says while the page is on the way. "Opening..." unless said. */
  busyText?: string;
  /**
   * A document (a PDF, a contract in WorkDrive), not a screen: opens in a new
   * tab, and nothing here waits for it, since a file never says it is drawn.
   */
  file?: boolean;
}

type ButtonAttrs = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type" | "formAction">;

export interface ControlButtonProps extends ButtonAttrs {
  href?: undefined;
  children: React.ReactNode;
  /** "submit" sends its form. A plain button otherwise. */
  type?: "submit" | "button";
  /** What it says while it works: "Rating...". "Working..." unless said. */
  busyText?: string;
  /** For a submit: cover the page ("page") or lock the panel it sits in ("panel"). */
  working?: WorkingScope;
  /** For Submit and Void: the warning shown if the page is left while it runs. */
  leave?: string;
  /** A second server action in the same form, as on a plain button. */
  formAction?: (formData: FormData) => void | Promise<void>;
  /** What a press does. Return the promise to stay busy until it settles. */
  onPress?: (e: React.MouseEvent<HTMLButtonElement>) => unknown;
  /** The button element, for a caller that moves focus (a radio group). */
  ref?: React.Ref<HTMLButtonElement>;
}

export type ControlProps = ControlLinkProps | ControlButtonProps;

function isOtherSite(href: string): boolean {
  return /^(https?:)?\/\//i.test(href) || /^(mailto|tel):/i.test(href);
}

export default function Control(props: ControlProps) {
  return props.href !== undefined ? <ControlLink {...props} /> : <ControlButton {...props} />;
}

function ControlButton(props: ControlButtonProps) {
  const {
    children, type = "button", busyText = WORKING, working = "panel", leave, onPress,
    className = type === "submit" ? "btn btn--quiet" : undefined, disabled, ref: outerRef, ...rest
  } = props;
  const status = useFormStatus();
  const area = useWorking();
  const self = useRef<HTMLButtonElement>(null);
  const [pressing, setPressing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A submit: inside a working area, busy only when this is the button that
  // sent the form (a form can have more than one); outside one, the form's
  // own state. A press: while its promise runs.
  const sending = type === "submit" && (area ? area.running?.submitter === self.current && self.current !== null : status.pending);
  const busy = sending || pressing;

  const onClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (busy) {
      e.preventDefault();
      return;
    }
    if (!onPress) return;
    setError(null);
    const result = onPress(e);
    if (!(result instanceof Promise)) return;
    setPressing(true);
    try {
      await result;
    } catch (err) {
      setError(plainError(err));
    } finally {
      setPressing(false);
    }
  };

  return (
    <>
      <button
        {...rest}
        ref={(el) => {
          self.current = el;
          if (typeof outerRef === "function") outerRef(el);
          else if (outerRef) (outerRef as React.RefObject<HTMLButtonElement | null>).current = el;
        }}
        type={type}
        className={`${className ?? ""}${busy ? " is-busy" : ""}`.trim() || undefined}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        onClick={onClick}
        // What Working.tsx reads to cover the page or lock the panel.
        data-working={type === "submit" ? working : undefined}
        data-working-label={type === "submit" ? busyText : undefined}
        data-working-leave={type === "submit" ? leave : undefined}
      >
        {/* A submit tells the page's working state when its form's action has
            answered, without its author having to remember to. */}
        {type === "submit" ? <Working /> : null}
        {busy ? (
          <>
            <span className="btn-spinner" aria-hidden="true" />
            {busyText}
          </>
        ) : (
          children
        )}
      </button>
      {error ? (
        <span className="control-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

function ControlLink(props: ControlLinkProps) {
  const { href, children, newTab = false, busyText = OPENING, file = false, className, ...rest } = props;
  const self = useRef<HTMLAnchorElement>(null);
  const nav = useNavBusy();
  const external = file || isOtherSite(href);
  // A jump within this page (#field-engine.ccs): nothing to load, nothing to wait for.
  const inPage = href.startsWith("#");
  const busy = !!nav && nav.source === self.current && self.current !== null;

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (external || inPage) return;
    // The browser's own new tab: let it, and do not wait here.
    if (!newTab && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
    // One page change at a time: a second press does nothing.
    if (!startNav(self.current, href, newTab)) {
      e.preventDefault();
      return;
    }
    // A link to the page already showing changes nothing, so there is no
    // next page to wait for.
    if (!newTab && pathOf(href) === window.location.pathname + window.location.search) endNav();
  };

  const look = `${className ?? ""}${busy ? " is-busy" : ""}`.trim() || undefined;
  const inner = busy ? (
    <>
      <span className="btn-spinner" aria-hidden="true" />
      {busyText}
    </>
  ) : (
    children
  );
  const common = {
    ...rest,
    ref: self,
    className: look,
    onClick,
    "aria-disabled": busy || undefined,
    "aria-busy": busy || undefined,
  };

  if (inPage) {
    return (
      <a {...common} href={href}>
        {inner}
      </a>
    );
  }
  if (external || newTab) {
    // A new tab with no handle back to this one, and no referrer to another site.
    return (
      <a {...common} href={href} target="_blank" rel={external ? "noopener noreferrer" : "noopener"}>
        {inner}
      </a>
    );
  }
  return (
    <Link {...common} href={href} prefetch={false}>
      {inner}
    </Link>
  );
}
