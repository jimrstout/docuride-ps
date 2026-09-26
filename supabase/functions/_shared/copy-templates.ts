// _shared/copy-templates.ts
//
// Customer-facing sentences that name a dealer group or an amount.
//
// ── Why these are not string literals ────────────────────────────────────
// The disappearing deductible sentence has to say two things we do not know at
// build time: the dealer group's name, and the deductible the customer is
// actually buying. Riders' rule for this group is that the deductible drops to
// zero at any of the group's stores; another group's terms may be narrower, and
// the amount comes off the chosen rate rather than the sentence, so that a rate
// change cannot leave a customer reading a number that is no longer true.
//
// So the sentence lives in fni.copy_templates, a tenant row overriding a
// platform default, and this module is the only thing that fills it in.
//
// ── A hole in a sentence is worse than no sentence ───────────────────────
// If a placeholder has no value -- no group name has been entered yet, or the
// rate carries no deductible -- the whole line is dropped. Rendering "Your
// deductible drops to $0 at any store" without the amount, or worse with a
// literal {dealer_group_name} in it, is the kind of thing a customer screenshots.

export const TEMPLATE_KEYS = {
  /** Shown only for a rate the provider marks as a disappearing deductible. */
  disappearingDeductible: "deductible.disappearing",
} as const;

/**
 * The placeholders each template is allowed to use.
 *
 * Checked when someone saves a template, so a typo like {dealer_group} is
 * refused at the point of editing rather than discovered by a buyer.
 */
export const ALLOWED_PLACEHOLDERS: Record<string, readonly string[]> = {
  [TEMPLATE_KEYS.disappearingDeductible]: ["dealer_group_name", "deductible_amount"],
};

const PLACEHOLDER_RE = /\{([a-z0-9_]+)\}/gi;

/** Every {placeholder} the body references, in order, without duplicates. */
export function placeholdersIn(body: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    const name = m[1];
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

export interface TemplateProblem {
  placeholder: string;
  reason: "unknown";
}

/**
 * Placeholders in the body that this key does not offer.
 *
 * An empty array means the body is safe to save. A key with no registered
 * placeholder list is not validated, because inventing a rule for a template
 * nobody has defined yet would only be wrong later.
 */
export function validateTemplate(templateKey: string, body: string): TemplateProblem[] {
  const allowed = ALLOWED_PLACEHOLDERS[templateKey];
  if (!allowed) return [];
  return placeholdersIn(body)
    .filter((p) => !allowed.includes(p))
    .map((placeholder) => ({ placeholder, reason: "unknown" as const }));
}

/**
 * Fill a template, or return null if it cannot be filled honestly.
 *
 * Null rather than a partial sentence: the caller omits the line. A value that
 * is present but blank counts as missing, because a trimmed-empty dealer group
 * name is the same problem as an absent one.
 */
export function renderTemplate(
  body: string | null | undefined,
  values: Record<string, string | null | undefined>
): string | null {
  if (typeof body !== "string" || body.trim() === "") return null;

  for (const name of placeholdersIn(body)) {
    const v = values[name];
    if (typeof v !== "string" || v.trim() === "") return null;
  }

  return body.replace(PLACEHOLDER_RE, (_whole, name: string) =>
    String(values[name]).trim()
  );
}

/**
 * The body in force for a tenant: its own row, else the platform default.
 *
 * Mirrors how fni.product_catalog resolves a store row over a tenant-wide one.
 */
export interface CopyTemplateRow {
  tenant_id: string | null;
  template_key: string;
  body: string;
}

export function resolveTemplates(rows: CopyTemplateRow[]): Map<string, string> {
  const out = new Map<string, string>();
  // Defaults first, then let a tenant row overwrite.
  for (const r of rows.filter((r) => r.tenant_id === null)) out.set(r.template_key, r.body);
  for (const r of rows.filter((r) => r.tenant_id !== null)) out.set(r.template_key, r.body);
  return out;
}
