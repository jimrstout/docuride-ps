// app/admin/pricing/page.tsx: what the menu's products sell for.
//
// Each product's price is its dealer cost plus a markup, from the rules here:
// a percentage, held between a minimum and a maximum number of dollars, then
// rounded. A store with rules of its own uses them; a store with none uses All
// stores; a cost no rule covers is not priced, and the planner leaves that
// product out rather than show a guess.
//
// ── Nothing is worked out here ──────────────────────────────────────────
// The summaries, the store statuses, the preview and the gap check all come
// from fni-admin-settings, which works them out with the planner's own
// priceProduct and resolveRule. A preview priced by a second copy of the
// formula would be a preview of something no customer sees.
//
// Writes go through the server actions to the same function, which checks them
// and records who made them. Behind the admin layout's sign-in, like every page
// in the admin area.
//
// The cost coverage bar is drawing, not pricing: it lays out the scope's own
// bands and the gaps the function found, and labels what lies between them as
// covered by All stores.
//
// Edit and Add rule are links (?edit=<rule id>, ?add=1) that open the one rule
// form under the table, so the page still works with no JavaScript and has no
// pop-up dialogs.

import Link from "next/link";
import { currentOperator } from "@/lib/admin-session";
import { edge, EdgeError } from "@/lib/edge";
import type { PricingPayload, PricingPreviewRow, PricingRuleRow, PricingStoreStatus } from "@/lib/types";
import { copyPricingRules, deletePricingRule, savePricingRule } from "@/app/console-actions";
import { Badge, Notice, PageHead } from "@/components/admin/Parts";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The range the gap check covers, and so the range the coverage bar draws. */
const RANGE_TO = 10000;

function one(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

function money(n: number): string {
  const whole = Math.abs(n - Math.round(n)) < 1e-9;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function percent(n: number): string {
  return `${Number(n.toFixed(3))}%`;
}

function changedOn(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // The stores are all in one time zone, and so is everyone who edits this.
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function lastChanged(rule: PricingRuleRow): string {
  const on = changedOn(rule.updated_at);
  if (rule.updated_by && on) return `Last changed by ${rule.updated_by} on ${on}.`;
  if (rule.updated_by) return `Last changed by ${rule.updated_by}.`;
  if (on) return `Last changed on ${on}. Who changed it was not recorded.`;
  return "Who last changed this was not recorded.";
}

function notice(params: Params): { tone: "good" | "warn"; text: string } | null {
  if (params.saved !== undefined) return { tone: "good", text: "Saved. It applies now." };
  if (params.deleted !== undefined) return { tone: "good", text: "Deleted. It no longer applies." };
  if (params.copied !== undefined) return { tone: "good", text: "Copied. The copies apply now." };
  if (typeof params.refused === "string") return { tone: "warn", text: params.refused };
  if (params.savefailed !== undefined) {
    return { tone: "warn", text: "That could not be saved just now. Nothing was changed. Try again shortly." };
  }
  return null;
}

/** A link within the page, keeping the scope and the preview's product and cost. */
function pageHref(storeId: string | null, keep: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  if (storeId !== null) q.set("scope", storeId);
  for (const [k, v] of Object.entries(keep)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `/admin/pricing?${s}` : "/admin/pricing";
}

function dotFor(status: PricingStoreStatus): string {
  if (status === "Own rules") return "ad-dot ad-dot--good";
  if (status === "Uses All stores") return "ad-dot";
  return "ad-dot ad-dot--warn";
}

const COLUMNS = [
  "Applies to",
  "Dealer cost from",
  "Dealer cost to",
  "Markup percent",
  "Minimum markup ($)",
  "Maximum markup ($)",
  "Round to ($)",
  "Active",
];

// ── The cost coverage bar ────────────────────────────────────────────────

type Segment = { kind: "band" | "gap" | "fallback"; from: number; to: number; label: string };

function coverage(payload: PricingPayload): Segment[] {
  // The scope's own bands for any product, narrowest first where two overlap.
  const bands = payload.rules
    .filter((r) => r.active && r.product_code === null)
    .sort((a, b) => (a.cost_ceiling - a.cost_floor) - (b.cost_ceiling - b.cost_floor));

  const edges = new Set<number>([0, RANGE_TO]);
  for (const r of bands) for (const e of [r.cost_floor, r.cost_ceiling]) if (e > 0 && e < RANGE_TO) edges.add(e);
  for (const g of payload.gaps) for (const e of [g.from, g.to]) if (e > 0 && e < RANGE_TO) edges.add(e);
  const points = [...edges].sort((a, b) => a - b);

  const out: (Segment & { key: string })[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const gap = payload.gaps.some((g) => from >= g.from && from < g.to);
    const band = gap ? undefined : bands.find((r) => from >= r.cost_floor && from < r.cost_ceiling);
    const key = gap ? "gap" : band ? `band:${band.id}` : "fallback";
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.to = to;
      continue;
    }
    out.push({ key, kind: gap ? "gap" : band ? "band" : "fallback", from, to, label: "" });
  }

  return out.map((s) => {
    const band = s.kind === "band" ? bands.find((r) => `band:${r.id}` === s.key)! : null;
    const upTo = band ? band.cost_ceiling : s.to;
    const span = upTo >= RANGE_TO && s.kind !== "band" ? `${money(s.from)} and up` : `${money(band ? band.cost_floor : s.from)} to ${money(upTo)}`;
    const label =
      s.kind === "gap" ? `${span}: no rule`
      : s.kind === "band" ? `${span} · ${percent(band!.markup_percent)}`
      : `${span} · All stores`;
    return { kind: s.kind, from: s.from, to: s.to, label };
  });
}

function CoverageBar({ payload }: { payload: PricingPayload }) {
  const segments = coverage(payload);
  return (
    <>
      <div className="ad-cover" role="list" aria-label="Which rule covers each dealer cost, from $0 to $10,000">
        {segments.map((s) => (
          <span
            key={`${s.from}-${s.kind}`}
            role="listitem"
            className={`ad-cover-seg${s.kind === "gap" ? " ad-cover-seg--gap" : s.kind === "fallback" ? " ad-cover-seg--fallback" : ""}`}
            title={s.label}
          >
            {s.label}
          </span>
        ))}
      </div>
      {payload.gaps.length > 0 ? (
        <div className="ad-gaps">
          {payload.gaps.map((g) => <p key={g.from}>{g.sentence}</p>)}
        </div>
      ) : null}
    </>
  );
}

// ── The rules table and the one rule form ────────────────────────────────

function RuleRow({ rule, editHref }: { rule: PricingRuleRow; editHref: string }) {
  return (
    <tr>
      <td>
        <span className="ad-strong">{rule.product_name ?? (rule.product_code === null ? "All products" : rule.product_code)}</span>
        <small>{rule.summary}</small>
        <small>{lastChanged(rule)}</small>
      </td>
      <td className="num">{money(rule.cost_floor)}</td>
      <td className="num">{money(rule.cost_ceiling)}</td>
      <td className="num">{percent(rule.markup_percent)}</td>
      <td className="num">{money(rule.markup_min_dollars)}</td>
      <td className="num">{rule.markup_max_dollars === null ? "No maximum" : money(rule.markup_max_dollars)}</td>
      <td className="num">{rule.round_to > 0 ? money(rule.round_to) : "Not rounded"}</td>
      <td>{rule.active ? <Badge tone="good">Active</Badge> : <Badge>Turned off</Badge>}</td>
      <td>
        <Link className="ad-btn ad-btn--secondary" href={editHref} prefetch={false}>
          Edit
        </Link>
      </td>
    </tr>
  );
}

function RuleForm({
  rule,
  scope,
  products,
  cancelHref,
}: {
  rule: PricingRuleRow | null;
  scope: string;
  products: PricingPayload["products"];
  cancelHref: string;
}) {
  // A rule naming a product no longer in the catalog still shows it, so saving
  // the row does not quietly turn it into an All products rule.
  const known = rule?.product_code == null || products.some((p) => p.code === rule.product_code);

  return (
    <form action={savePricingRule} className="ad-editor" id="rule-form">
      <h3>{rule ? "Edit rule" : "Add a rule"}</h3>
      {rule ? <p className="ad-help">{rule.summary}</p> : null}
      <input type="hidden" name="scope" value={scope} />
      {rule ? <input type="hidden" name="rule_id" value={rule.id} /> : null}

      <div className="ad-editor-fields">
        <label className="ad-field ad-field--wide">
          <span>Applies to</span>
          <select name="product_code" defaultValue={rule?.product_code ?? ""}>
            <option value="">All products</option>
            {products.map((p) => (
              <option key={p.code} value={p.code}>{p.name}</option>
            ))}
            {known ? null : <option value={rule!.product_code!}>{rule!.product_code}</option>}
          </select>
        </label>
        <label className="ad-field">
          <span>Dealer cost from</span>
          <input name="cost_floor" inputMode="decimal" defaultValue={rule ? String(rule.cost_floor) : ""} required />
        </label>
        <label className="ad-field">
          <span>Dealer cost to</span>
          <input name="cost_ceiling" inputMode="decimal" defaultValue={rule ? String(rule.cost_ceiling) : ""} required />
        </label>
        <label className="ad-field">
          <span>Markup percent</span>
          <input name="markup_percent" inputMode="decimal" defaultValue={rule ? String(rule.markup_percent) : ""} required />
        </label>
        <label className="ad-field">
          <span>Minimum markup ($)</span>
          <input name="markup_min_dollars" inputMode="decimal" defaultValue={rule ? String(rule.markup_min_dollars) : "0"} />
        </label>
        <label className="ad-field">
          <span>Maximum markup ($)</span>
          <input
            name="markup_max_dollars"
            inputMode="decimal"
            defaultValue={rule?.markup_max_dollars == null ? "" : String(rule.markup_max_dollars)}
            placeholder="No maximum"
          />
        </label>
        <label className="ad-field">
          <span>Round to ($)</span>
          <input name="round_to" inputMode="decimal" defaultValue={rule ? String(rule.round_to) : "5"} />
        </label>
        <label className="ad-check">
          <input type="checkbox" name="active" defaultChecked={rule ? rule.active : true} />
          <span>Active</span>
        </label>
      </div>

      <p className="ad-help">
        A rule covers costs from its first number up to, but not including, its
        second, so one rule can end where the next begins. Leave Maximum markup
        blank for no maximum.
      </p>

      <div className="ad-editor-actions">
        <button type="submit" className="ad-btn ad-btn--primary">{rule ? "Save" : "Add rule"}</button>
        <Link className="ad-btn ad-btn--secondary" href={cancelHref} prefetch={false}>
          Cancel
        </Link>
        {rule ? (
          <button type="submit" formAction={deletePricingRule} className="ad-btn ad-btn--secondary ad-push" formNoValidate>
            Delete
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** One copy, as a single button. The same copy action as "Copy these rules to...". */
function CopyButton({ from, to, label, primary }: { from: string; to: string; label: string; primary?: boolean }) {
  return (
    <form action={copyPricingRules}>
      <input type="hidden" name="scope" value={from} />
      <input type="hidden" name="to_scope" value={to} />
      <button type="submit" className={primary ? "ad-btn ad-btn--primary" : "ad-btn ad-btn--secondary"}>
        {label}
      </button>
    </form>
  );
}

// ── The preview ──────────────────────────────────────────────────────────

function PreviewRow({ row, payload }: { row: PricingPreviewRow; payload: PricingPayload }) {
  const own = row.rule_id ? payload.rules.find((r) => r.id === row.rule_id) : undefined;
  const from =
    row.price === null ? "No rule covers this cost"
    : own ? `${money(own.cost_floor)} to ${money(own.cost_ceiling)} · ${percent(own.markup_percent)}`
    : row.rule_from === "All stores" ? "All stores rule"
    : "This store's rule";

  return (
    <tr>
      <td className="num">{money(row.cost)}</td>
      <td className="num" title={row.rule_summary ?? row.reason ?? undefined}>
        {row.price === null ? <span>Not shown</span> : <span className="ad-price">{money(row.price)}</span>}
        <small>{from}</small>
      </td>
    </tr>
  );
}

function Preview({ payload, here, cost }: { payload: PricingPayload; here: string | null; cost: string }) {
  return (
    <section className="ad-panel" aria-labelledby="preview-title">
      <div className="ad-panel-head">
        <h2 id="preview-title">What a customer pays</h2>
      </div>
      <div className="ad-preview-body">
        <div className="ad-scroll">
          <table className="ad-table ad-preview">
            <thead>
              <tr>
                <th scope="col" className="num">Dealer cost</th>
                <th scope="col" className="num">Customer price</th>
              </tr>
            </thead>
            <tbody>
              {payload.preview.rows.map((row) => <PreviewRow key={row.cost} row={row} payload={payload} />)}
              {payload.preview.typed ? <PreviewRow row={payload.preview.typed} payload={payload} /> : null}
            </tbody>
          </table>
        </div>
        <form method="get" action="/admin/pricing" className="ad-preview-form">
          {here !== null ? <input type="hidden" name="scope" value={here} /> : null}
          <label className="ad-field">
            <span>Product</span>
            <select name="product" defaultValue={payload.preview.product_code ?? ""}>
              <option value="">Any product without its own rule</option>
              {payload.products.map((p) => (
                <option key={p.code} value={p.code}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="ad-field">
            <span>Try a dealer cost</span>
            <span className="ad-row">
              <input name="cost" inputMode="decimal" defaultValue={cost} placeholder="For example 750" />
              <button type="submit" className="ad-btn ad-btn--secondary">Show</button>
            </span>
          </label>
          {cost && !payload.preview.typed ? (
            <p className="ad-help">That cost could not be read. Type a number, for example 750.</p>
          ) : null}
          <p className="ad-help">
            Priced exactly as the planner prices it, at{" "}
            {here === null ? "a store using All stores" : payload.scope.name}.
          </p>
        </form>
      </div>
    </section>
  );
}

// ── The page ─────────────────────────────────────────────────────────────

async function Pricing({ params }: { params: Params }) {
  const scopeParam = one(params.scope);
  const scope = UUID_RE.test(scopeParam) ? scopeParam : "all";
  const product = one(params.product);
  const cost = one(params.cost);
  const editing = one(params.edit);
  const adding = params.add !== undefined;

  let payload: PricingPayload;
  try {
    payload = await edge.adminPricing<PricingPayload>({
      scope,
      ...(product ? { product } : {}),
      ...(cost ? { cost } : {}),
    });
  } catch (err) {
    console.error("console pricing load failed:", err);
    const why = err instanceof EdgeError && err.status === 400 ? err.message : null;
    return (
      <>
        <PageHead title="Pricing" subtitle="Markup added to the TecAssured dealer cost." />
        <Notice tone="warn">{why ?? "Pricing is unavailable right now. Try again shortly."}</Notice>
        {why ? (
          <p>
            <Link className="ad-btn ad-btn--secondary" href="/admin/pricing" prefetch={false}>Back to All stores</Link>
          </p>
        ) : null}
      </>
    );
  }

  const flash = notice(params);
  const here = payload.scope.store_id;
  const keep = { product, cost };
  const editRule = editing ? payload.rules.find((r) => r.id === editing) ?? null : null;
  const formOpen = adding || editRule !== null;
  const closeHref = pageHref(here, keep);

  const withRules = payload.stores.filter((s) => s.status === "Own rules");
  const unpriced = payload.stores.filter((s) => s.status === "No pricing: products will not be shown");
  // The store whose rules a fix would copy: the first with rules of its own.
  const source = withRules[0] ?? null;
  const copySource = withRules.find((s) => s.id !== here) ?? null;

  return (
    <>
      <PageHead title="Pricing" subtitle="Markup added to the TecAssured dealer cost.">
        <span className="ad-attention">Changes apply right away, including to deals being presented now.</span>
      </PageHead>

      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <div className="ad-scopes">
        <nav className="ad-seg" aria-label="Store">
          <Link
            href={pageHref(null, keep)}
            prefetch={false}
            className={here === null ? "is-here" : undefined}
            aria-current={here === null ? "page" : undefined}
          >
            <span className={payload.all_stores_active_rules > 0 ? "ad-dot ad-dot--good" : "ad-dot ad-dot--none"} aria-hidden="true" />
            <span>All stores (default)</span>
            <span className="sr-only">
              {payload.all_stores_active_rules > 0 ? "Used by any store without its own rules" : "No rules yet"}
            </span>
          </Link>
          {payload.stores.map((s) => (
            <Link
              key={s.id}
              href={pageHref(s.id, keep)}
              prefetch={false}
              className={here === s.id ? "is-here" : undefined}
              aria-current={here === s.id ? "page" : undefined}
              title={s.status}
            >
              <span className={dotFor(s.status)} aria-hidden="true" />
              <span>{s.name}</span>
              <span className="sr-only">{s.status}</span>
            </Link>
          ))}
        </nav>
        <p className="ad-help">
          {payload.stores.length > 0
            ? `The menu runs at: ${payload.stores.map((s) => s.name).join(", ")}.`
            : "The menu does not run at any store yet: no store has an active TecAssured account."}
        </p>
        <p className="ad-legend" aria-hidden="true">
          <span><span className="ad-dot ad-dot--good" />Own rules</span>
          <span><span className="ad-dot" />Uses All stores</span>
          <span><span className="ad-dot ad-dot--warn" />No pricing: products will not be shown</span>
        </p>
      </div>

      {unpriced.length > 0 ? (
        <section className="ad-panel ad-panel--warn" aria-label="Stores with no pricing">
          <div className="ad-panel-body">
            <p>
              {unpriced.map((s) => s.name).join(", ")}{" "}
              {unpriced.length === 1 ? "has" : "have"} no rules of {unpriced.length === 1 ? "its" : "their"} own,
              and All stores has none, so {unpriced.length === 1 ? "it shows" : "they show"} no products.
            </p>
            {source ? (
              <CopyButton from={source.id} to="all" label={`Copy ${source.name} to All stores`} primary />
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="ad-pricing-grid">
        <section className="ad-panel" aria-labelledby="rules-title">
          <div className="ad-panel-head">
            <h2 id="rules-title">Rules for {payload.scope.name}</h2>
            <Link className="ad-btn ad-btn--primary" href={`${pageHref(here, { ...keep, add: "1" })}#rule-form`} prefetch={false}>
              Add rule
            </Link>
          </div>

          <CoverageBar payload={payload} />

          {payload.rules.length === 0 ? (
            <div className="ad-panel-body">
              <p className="ad-help">
                {here === null
                  ? "No rules yet. A store without rules of its own falls back to these, so until there are some, those stores show no products."
                  : payload.all_stores_active_rules > 0
                    ? "No rules of its own. It falls back to All stores, so its products are priced by those rules."
                    : "It falls back to All stores, which has no rules either, so this store shows no products."}
              </p>
              <div className="ad-copy">
                <Link className="ad-btn ad-btn--primary" href={`${pageHref(here, { ...keep, add: "1" })}#rule-form`} prefetch={false}>
                  Add rule
                </Link>
                {copySource ? (
                  <CopyButton from={copySource.id} to={scope} label={`Copy rules from ${copySource.name}`} />
                ) : null}
              </div>
            </div>
          ) : (
            <div className="ad-scroll">
              <table className="ad-table ad-rules">
                <thead>
                  <tr>
                    {COLUMNS.map((c, i) => (
                      <th key={c} scope="col" className={i >= 1 && i <= 6 ? "num" : undefined}>{c}</th>
                    ))}
                    <th scope="col"><span className="sr-only">Edit</span></th>
                  </tr>
                </thead>
                <tbody>
                  {payload.rules.map((r) => (
                    <RuleRow key={r.id} rule={r} editHref={`${pageHref(here, { ...keep, edit: r.id })}#rule-form`} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {formOpen ? (
            <RuleForm rule={editRule} scope={scope} products={payload.products} cancelHref={closeHref} />
          ) : null}

          <footer className="ad-panel-foot">
            <span>
              {payload.rules.length} {payload.rules.length === 1 ? "rule" : "rules"}
            </span>
            {payload.rules.length > 0 && payload.copy_targets.length > 0 ? (
              <form action={copyPricingRules} className="ad-copy">
                <input type="hidden" name="scope" value={scope} />
                <label>
                  <span>Copy these rules to...</span>{" "}
                  <select name="to_scope" defaultValue="">
                    <option value="" disabled>Choose where</option>
                    {payload.copy_targets.map((t) => (
                      <option key={t.store_id ?? "all"} value={t.store_id ?? "all"} disabled={t.has_rules}>
                        {t.name}{t.has_rules ? " (already has rules)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="ad-btn ad-btn--secondary">Copy</button>
              </form>
            ) : null}
          </footer>
        </section>

        <Preview payload={payload} here={here} cost={cost} />
      </div>

      <details className="ad-details">
        <summary>How prices are worked out</summary>
        <p>
          {here === null
            ? "Any store without rules of its own uses these."
            : "This store uses these first. A cost they do not cover falls back to All stores."}{" "}
          A rule covers costs from its first number up to, but not including, its
          second, so one rule can end where the next begins. A product rule beats
          an All products rule. A cost no rule covers is not priced, and the
          planner leaves that product out rather than show a guess. Copying only
          goes to a place with no rules, so nothing is overwritten.
        </p>
      </details>
    </>
  );
}

export default async function PricingPage({ searchParams }: { searchParams: Promise<Params> }) {
  // The layout shows the sign-in form to anyone not signed in. Checked here as
  // well, from the same cached answer, so nothing is fetched for them.
  const operator = await currentOperator();
  if (!operator) return null;

  return <Pricing params={await searchParams} />;
}
