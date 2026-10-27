// lib/working.ts: what an action that waits on the server looks like.
//
// The rules behind components/Working.tsx, with no React and no DOM types, so a
// Node test can hold them.
//
// Every form on a staff page says, in data attributes on the form or on the
// button that sent it, how big its action is:
//
//   data-working="page"   the whole deal: Rate, Refresh from CRM, a vehicle
//                         type change, Submit, Void, Move to Deal Jacket. A
//                         full-page overlay; nothing underneath can be used.
//   data-working="panel"  one thing: Get document, +24h, a single save. Only
//                         the panel it sits in is locked, with a spinner.
//   data-working-label    what the button and the overlay say: "Rating...".
//   data-working-leave    set only on Submit and Void: the warning shown if
//                         the page is left or reloaded while it runs.
//
// The button that sent it reads its label; the overlay or panel says it too.
// While anything runs, no other form on the page can be sent.

export type WorkingScope = "page" | "panel";

export interface WorkingJob {
  scope: WorkingScope;
  label: string;
  /** Shown if the page is left or reloaded while this runs. Null when leaving is harmless. */
  leave: string | null;
}

/** Attributes as the DOM gives them: a dataset, or anything shaped like one. */
export type Attributes = Partial<Record<"working" | "workingLabel" | "workingLeave" | "workingIntent", string>>;

/** The message added once an action has run this long. */
export const STILL_WORKING_AFTER_MS = 10_000;
export const STILL_WORKING = "Still working. This can take up to a minute.";

export const SUBMIT_LEAVE = "Contracts are still being submitted. Leaving now may leave them half done.";
export const VOID_LEAVE = "A contract is still being voided. Leaving now may leave it half done.";

/** What happens to the deal when its vehicle type is chosen: the whole deal changes. */
export const VEHICLE_TYPE_INTENT = "vehicle-type";
export const VEHICLE_TYPE_JOB: WorkingJob = {
  scope: "page",
  label: "Changing the vehicle type...",
  leave: null,
};

/**
 * What a send of this form is, from the button first (a form can hold more
 * than one kind of action) and then the form. Null when the form says nothing,
 * which leaves it out of the working state: signing out, for one.
 */
export function jobFor(submitter: Attributes | null, form: Attributes): WorkingJob | null {
  if (form.workingIntent === VEHICLE_TYPE_INTENT) return VEHICLE_TYPE_JOB;
  const scope = submitter?.working ?? form.working;
  if (scope !== "page" && scope !== "panel") return null;
  const label = (submitter?.workingLabel ?? form.workingLabel ?? "").trim() || "Working...";
  const leave = (submitter?.workingLeave ?? form.workingLeave ?? "").trim() || null;
  return { scope, label, leave };
}

// ── Keeping the person's entries ─────────────────────────────────────────
//
// On an error the page reloads with the error, and whatever was typed and not
// saved would be gone. So the form's entries are kept when it is sent and put
// back if the answer is an error. Hidden fields are the page's own and are
// never touched.

export interface FieldValue {
  name: string;
  /** For a radio or checkbox: the one this entry is about. */
  value: string;
  kind: "text" | "check";
  checked: boolean;
}

/** The shape of a form control, as much of it as this reads. */
export interface ControlLike {
  name: string;
  type: string;
  value: string;
  checked?: boolean;
  disabled?: boolean;
}

const SKIPPED = new Set(["hidden", "submit", "button", "reset", "file", "image", "password"]);

export function snapshotFields(controls: ControlLike[]): FieldValue[] {
  return controls
    .filter((c) => c.name && !SKIPPED.has(c.type) && !c.disabled)
    .map((c) =>
      c.type === "checkbox" || c.type === "radio"
        ? { name: c.name, value: c.value, kind: "check" as const, checked: c.checked === true }
        : { name: c.name, value: c.value, kind: "text" as const, checked: false }
    );
}

/**
 * Put kept entries back. Returns the controls changed, so the caller can tell
 * the page; a control already showing the kept entry is left alone.
 */
export function restoreFields<C extends ControlLike>(controls: C[], kept: FieldValue[]): C[] {
  const changed: C[] = [];
  for (const k of kept) {
    const target = controls.find((c) =>
      c.name === k.name && (k.kind === "text" ? !(c.type === "checkbox" || c.type === "radio") : c.value === k.value)
    );
    if (!target || SKIPPED.has(target.type)) continue;
    if (k.kind === "text" && target.value !== k.value) {
      target.value = k.value;
      changed.push(target);
    } else if (k.kind === "check" && target.checked !== k.checked) {
      target.checked = k.checked;
      changed.push(target);
    }
  }
  return changed;
}
