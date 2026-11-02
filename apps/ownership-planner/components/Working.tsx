"use client";

// components/Working.tsx: making it obvious when the page is waiting on the server.
//
// Rating, refreshing from the CRM, submitting and voiding all take seconds,
// and the page used to look idle while they ran: it scrolled, its fields could
// be edited, and its buttons could be pressed again. Now:
//
//   - The button that started it shows a spinner and says what it is doing,
//     and is disabled (components/Control.tsx).
//   - A whole-deal action covers the page with an overlay saying the same
//     thing; nothing underneath can be clicked or edited until it finishes.
//     A smaller one locks only its panel, with a spinner in it.
//   - No other form on the page can be sent until it finishes.
//   - After ten seconds: "Still working. This can take up to a minute."
//   - During Submit and Void, leaving or reloading the page asks first.
//   - Screen readers are told when it starts and how it ended.
//   - When it ends, the result is shown where the person is looking, and on
//     an error their entries are put back so nothing has to be retyped.
//
// How a form says what it is: lib/working.ts. Every such form carries one
// <Working /> marker, which is how the page learns the action has ended (the
// form's pending state from React). What the action does is not touched.
//
// The state lives in this module rather than in the component, because an
// answer that reloads the page with a new address remounts the page, and the
// job, the kept entries and the result line must survive that. In memory
// only, for this tab, and gone as soon as the job ends.

import Control from "@/components/Control";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { useFormStatus } from "react-dom";
import {
  caughtUp,
  jobFor,
  RENDER_STAMP_ATTR,
  RENDER_WAIT_MS,
  restoreFields,
  snapshotFields,
  STILL_WORKING,
  STILL_WORKING_AFTER_MS,
  type ControlLike,
  type FieldValue,
  type WorkingJob,
} from "@/lib/working";

/** After this long with no answer, say so and offer a reload rather than spin for ever. */
const STUCK_AFTER_MS = 120_000;

interface Running extends WorkingJob {
  form: HTMLFormElement;
  /** Where the form sits among the page's forms, to find it again after a reload. */
  formIndex: number;
  submitter: HTMLElement | null;
  panel: HTMLElement | null;
  kept: FieldValue[];
  resultsBefore: Set<string>;
  /** Set by resend(): the form's own work is done and its one real send may go. */
  resendAllowed: boolean;
  /** The page's render marker when the action started, or null if it has none. */
  renderBefore: string | null;
  /** Already waiting for the new render: a second "the form ended" changes nothing. */
  waiting?: boolean;
  /** Already finishing: a form with two markers (its own and its button's) ends once. */
  finishing?: boolean;
}

interface Result {
  tone: "ok" | "bad";
  text: string;
}

interface State {
  running: Running | null;
  slow: boolean;
  stuck: boolean;
  result: Result | null;
  announce: string;
}

// ── The store ──────────────────────────────────────────────────────────

let state: State = { running: null, slow: false, stuck: false, result: null, announce: "" };
const listeners = new Set<() => void>();
let timers: ReturnType<typeof setTimeout>[] = [];
let watcher: MutationObserver | null = null;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The page's render marker (components/RenderStamp), or null if it has none. */
function renderStamp(): string | null {
  return document.querySelector<HTMLElement>(`[${RENDER_STAMP_ATTR}]`)?.getAttribute(RENDER_STAMP_ATTR) ?? null;
}

/** The ids of the result lines (flash notices) on the page right now. */
function resultIds(): Set<string> {
  return new Set(
    Array.from(document.querySelectorAll<HTMLElement>("[data-working-result]")).map(
      (el) => el.dataset.workingResultId ?? el.textContent ?? ""
    )
  );
}

/** The result line the action left behind, if it left a new one. */
function newResult(before: Set<string>): Result | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-working-result]"))) {
    const id = el.dataset.workingResultId ?? el.textContent ?? "";
    if (before.has(id)) continue;
    const text = (el.textContent ?? "").trim();
    if (text === "") continue;
    return { tone: el.dataset.workingResult === "bad" ? "bad" : "ok", text };
  }
  return null;
}

function begin(job: WorkingJob, form: HTMLFormElement, submitter: HTMLElement | null = null) {
  if (state.running) return;
  // A new job: the last one's result is no longer being looked for.
  watcher?.disconnect();
  watcher = null;
  const r: Running = {
    ...job,
    form,
    formIndex: Array.from(document.forms).indexOf(form),
    submitter,
    panel: job.scope === "panel" ? ((form.closest("[data-working-panel]") as HTMLElement | null) ?? form) : null,
    kept: snapshotFields(Array.from(form.elements) as unknown as ControlLike[]),
    resultsBefore: resultIds(),
    resendAllowed: false,
    renderBefore: renderStamp(),
  };
  for (const t of timers) clearTimeout(t);
  timers = [
    setTimeout(() => state.running === r && set({ slow: true }), STILL_WORKING_AFTER_MS),
    setTimeout(() => state.running === r && set({ stuck: true }), STUCK_AFTER_MS),
  ];
  set({ running: r, slow: false, stuck: false, result: null, announce: job.label });
}

/**
 * The form's action has answered. A redirecting action answers before the
 * page it leads to has been drawn, so the job ends once the page has settled
 * (it changed and then went quiet, or nothing changed for a moment), and the
 * result line is looked for as it appears, for a while after that.
 */
const QUIET_MS = 400;
const NOTHING_CHANGED_MS = 1500;
const RESULT_WATCH_MS = 15_000;

function finish() {
  const r = state.running;
  if (!r || r.finishing) return;
  r.finishing = true;
  watcher?.disconnect();

  // ── A page with a render marker: wait for the new render ──────────────
  // The action has answered, but its answer is not on the screen until the
  // page it redirected to has been drawn, which can take seconds more (Details
  // reads the CRM and the DX1 check as it renders). Ending at the answer, or
  // when the page went quiet, dropped the spinner while the old figures were
  // still showing, and invited a second press. So the job, its spinner, its
  // overlay and its disabled buttons stay until a new marker is on the page.
  // "Still working" and the stuck message keep their timers meanwhile.
  if (r.renderBefore !== null) {
    r.waiting = true;
    let done = false;
    const settle = () => {
      if (done || !caughtUp(r.renderBefore, renderStamp())) return;
      done = true;
      obs.disconnect();
      if (watcher === obs) watcher = null;
      clearTimeout(giveUp);
      for (const t of timers) clearTimeout(t);
      timers = [];
      const res = newResult(r.resultsBefore);
      if (res && res.tone === "bad" && r.kept.length > 0) {
        const form = (r.form.id ? (document.getElementById(r.form.id) as HTMLFormElement | null) : null) ??
          (document.forms[r.formIndex] as HTMLFormElement | undefined) ?? null;
        if (form) restoreFields(Array.from(form.elements) as unknown as (ControlLike & Element)[], r.kept);
      }
      if (state.running === r) {
        set({ running: null, slow: false, stuck: false, result: res ?? state.result, announce: res ? res.text : "Done." });
      }
    };
    const obs = new MutationObserver(settle);
    watcher = obs;
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: [RENDER_STAMP_ATTR] });
    // Never wait for ever: after this long, end, and the stuck message has
    // already offered a reload.
    const giveUp = setTimeout(() => {
      r.renderBefore = null;
      settle();
    }, RENDER_WAIT_MS);
    requestAnimationFrame(settle);
    return;
  }

  for (const t of timers) clearTimeout(t);
  timers = [];

  let ended = false;
  let found = false;
  let quiet: ReturnType<typeof setTimeout> | null = null;

  const end = () => {
    if (ended) return;
    ended = true;
    if (quiet) clearTimeout(quiet);
    if (state.running === r) {
      set({ running: null, slow: false, stuck: false, announce: found ? state.announce : "Done." });
    }
  };

  const look = () => {
    if (found) return;
    const res = newResult(r.resultsBefore);
    if (!res) return;
    found = true;
    if (res.tone === "bad" && r.kept.length > 0) {
      const form = r.form.isConnected
        ? r.form
        : (r.form.id ? (document.getElementById(r.form.id) as HTMLFormElement | null) : null) ??
          (document.forms[r.formIndex] as HTMLFormElement | undefined) ?? null;
      if (form) restoreFields(Array.from(form.elements) as unknown as (ControlLike & Element)[], r.kept);
    }
    set({ result: res, announce: res.text });
    end();
    stop();
  };

  const obs = new MutationObserver(() => {
    look();
    if (ended) return;
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(end, QUIET_MS);
  });
  watcher = obs;
  const stop = () => {
    obs.disconnect();
    if (watcher === obs) watcher = null;
  };
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });

  // The answer may already be on the page.
  requestAnimationFrame(look);
  setTimeout(() => {
    if (!ended && !quiet) end();
  }, NOTHING_CHANGED_MS);
  setTimeout(() => {
    end();
    stop();
  }, RESULT_WATCH_MS);
}

// ── The area ───────────────────────────────────────────────────────────

interface WorkingApi {
  running: Running | null;
  /**
   * For a form that does work of its own before it sends (an upload first,
   * then the save): mark the work as begun. Its own later send goes through;
   * the <Working /> marker in it ends the job, or done() does if it stops.
   */
  start: (job: WorkingJob, form: HTMLFormElement, submitter?: HTMLElement | null) => void;
  /** The form's own work is done: let its next send through, once. */
  resend: () => void;
  done: () => void;
}

function resend() {
  if (state.running) state.running.resendAllowed = true;
}

const WorkingContext = createContext<WorkingApi | null>(null);

export function useWorking(): WorkingApi | null {
  return useContext(WorkingContext);
}

const serverState: State = { running: null, slow: false, stuck: false, result: null, announce: "" };

export function WorkingArea({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const s = useSyncExternalStore(subscribe, () => state, () => serverState);

  // ── Claiming a send ──────────────────────────────────────────────────
  // In the capture phase, so it runs before React sends the form. A send
  // while another is running is stopped here, before anything leaves.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onSubmit = (e: Event) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (state.running) {
        // The form that is running may send itself once, when its own work
        // is done and it says so (an upload done, now the save). Anything
        // else waits, a second tap on the same button included: that tap can
        // land before the button has been redrawn as disabled, and it used to
        // go through, which is how one +24h could extend a session twice.
        if (state.running.form === form && state.running.resendAllowed) {
          state.running.resendAllowed = false;
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const submitter = ((e as SubmitEvent).submitter ?? null) as HTMLElement | null;
      const intent = form.dataset.workingIntent;
      delete form.dataset.workingIntent;
      const job = jobFor(submitter ? { ...submitter.dataset } : null, { ...form.dataset, workingIntent: intent });
      if (job) begin(job, form, submitter);
    };
    el.addEventListener("submit", onSubmit, true);
    return () => el.removeEventListener("submit", onSubmit, true);
  }, []);

  // ── While it runs: the trigger, the panel, and leaving the page ──────
  const running = s.running;
  useEffect(() => {
    if (!running) return;
    const trigger = running.submitter;
    trigger?.setAttribute("data-working-trigger", "");
    const panel = running.panel;
    // A button inside the panel that started the job already shows a spinner
    // and says what it is doing. The panel then locks without saying it again:
    // two labels drawn one over the other was the doubled "Adding 24 hours...".
    const quiet = !!(panel && trigger && panel.contains(trigger));
    if (panel) {
      panel.inert = true;
      panel.setAttribute("aria-busy", "true");
      panel.classList.add("is-working");
      if (quiet) panel.classList.add("is-working--quiet");
    }
    // Submit and Void: leaving now could leave them half done.
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = running.leave ?? "";
      return running.leave ?? "";
    };
    if (running.leave) window.addEventListener("beforeunload", onLeave);
    return () => {
      trigger?.removeAttribute("data-working-trigger");
      if (panel) {
        panel.inert = false;
        panel.removeAttribute("aria-busy");
        panel.classList.remove("is-working", "is-working--quiet");
        delete panel.dataset.workingText;
      }
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [running]);

  useEffect(() => {
    if (running?.panel) running.panel.dataset.workingText = s.slow ? `${running.label} ${STILL_WORKING}` : running.label;
  }, [s.slow, running]);

  // A success line clears itself; an error stays until it is dismissed.
  const result = s.result;
  useEffect(() => {
    if (result?.tone !== "ok") return;
    const t = setTimeout(() => state.result === result && set({ result: null }), 8000);
    return () => clearTimeout(t);
  }, [result]);

  const page = running?.scope === "page";

  return (
    <WorkingContext.Provider value={{ running, start: begin, resend, done: finish }}>
      <div
        ref={root}
        className="working-area"
        data-working-on={running ? running.scope : undefined}
        aria-busy={page || undefined}
        inert={page || undefined}
      >
        {children}
      </div>

      {page ? (
        <div className="working-overlay" role="status" aria-labelledby="working-say">
          <div className="working-box">
            <span className="working-spinner" aria-hidden="true" />
            <p id="working-say" className="working-say">{running.label}</p>
            {s.slow ? <p className="working-slow">{STILL_WORKING}</p> : null}
            {s.stuck ? (
              <p className="working-slow">
                This is taking longer than it should. Reload the page to see where it got to.{" "}
                <Control className="btn btn--quiet" onPress={() => window.location.reload()}>
                  Reload
                </Control>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {result ? (
        <div className={`working-result working-result--${result.tone}`} role={result.tone === "bad" ? "alert" : "status"}>
          <p>{result.text}</p>
          <Control className="working-result-close" onPress={() => set({ result: null })}>
            Dismiss
          </Control>
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {s.announce}
      </p>
    </WorkingContext.Provider>
  );
}

/**
 * Put one inside every form whose action waits on the server. It tells the
 * page when the action has ended: when React says the form is no longer
 * pending, or when the form is gone from the page the answer drew.
 */
export function Working() {
  const { pending } = useFormStatus();
  const sawPending = useRef(false);

  useEffect(() => {
    if (pending) sawPending.current = true;
    else if (sawPending.current) {
      sawPending.current = false;
      finish();
    }
  }, [pending]);

  useEffect(
    () => () => {
      if (sawPending.current) finish();
    },
    []
  );

  return null;
}
