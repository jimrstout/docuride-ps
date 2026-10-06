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

import Link from "next/link";
import { currentOperator } from "@/lib/admin-session";
import { edge, EdgeError } from "@/lib/edge";
import type { PricingPayload, PricingPreviewRow, PricingRuleRow } from "@/lib/types";
import { copyPricingRules, deletePricingRule, savePricingRule } from "@/app/console-actions";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function notice(params: Params): { tone: "ok" | "bad"; text: string } | null {
  if (params.saved !== undefined) return { tone: "ok", text: "Saved. It applies now." };
  if (params.deleted !== undefined) return { tone: "ok", text: "Deleted. It no longer applies." };
  if (params.copied !== undefined) return { tone: "ok", text: "Copied. The copies apply now." };
  if (typeof params.refused === "string") return { tone: "bad", text: params.refused };
  if (params.savefailed !== undefined) {
    return { tone: "bad", text: "That could not be saved just now. Nothing was changed. Try again shortly." };
  }
  return null;
}

/** A link to a scope, keeping the preview's product and cost. */
function scopeHref(storeId: string | null, keep: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  if (storeId !== null) q.set("scope", storeId);
  for (const [k, v] of Object.entries(keep)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `/admin/pricing?${s}` : "/admin/pricing";
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
  "",
];

function RuleForm({
  rule,
  scope,
  products,
}: {
  rule: PricingRuleRow | null;
  scope: string;
  products: PricingPayload["products"];
}) {
  const id = rule?.id ?? "new";
  const label = (col: string) => `${col}${rule ? `, rule ${rule.summary}` : ", new rule"}`;
  // A rule naming a product no longer in the catalog still shows it, so saving
  // the row does not quietly turn it into an All products rule.
  const known = rule?.product_code == null || products.some((p) => p.code === rule.product_code);

  return (
    <form action={savePricingRule} className={`price-rule${rule && !rule.active ? " is-off" : ""}`}>
      <input type="hidden" name="scope" value={scope} />
      {rule ? <input type="hidden" name="rule_id" value={rule.id} /> : null}

      <select name="product_code" defaultValue={rule?.product_code ?? ""} aria-label={label("Applies to")}>
        <option value="">All products</option>
        {products.map((p) => (
          <option key={p.code} value={p.code}>{p.name}</option>
        ))}
        {known ? null : <option value={rule!.product_code!}>{rule!.product_code}</option>}
      </select>
      <input name="cost_floor" inputMode="decimal" defaultValue={rule ? String(rule.cost_floor) : ""} aria-label={label("Dealer cost from")} required />
      <input name="cost_ceiling" inputMode="decimal" defaultValue={rule ? String(rule.cost_ceiling) : ""} aria-label={label("Dealer cost to")} required />
      <input name="markup_percent" inputMode="decimal" defaultValue={rule ? String(rule.markup_percent) : ""} aria-label={label("Markup percent")} required />
      <input name="markup_min_dollars" inputMode="decimal" defaultValue={rule ? String(rule.markup_min_dollars) : "0"} aria-label={label("Minimum markup")} />
      <input
        name="markup_max_dollars"
        inputMode="decimal"
        defaultValue={rule?.markup_max_dollars == null ? "" : String(rule.markup_max_dollars)}
        placeholder="No maximum"
        aria-label={label("Maximum markup, blank means no maximum")}
      />
      <input name="round_to" inputMode="decimal" defaultValue={rule ? String(rule.round_to) : "5"} aria-label={label("Round to")} />
      <label className="price-rule-active">
        <input type="checkbox" name="active" defaultChecked={rule ? rule.active : true} aria-label={label("Active")} />
        <span aria-hidden="true">Active</span>
      </label>
      <div className="price-rule-actions">
        <button type="submit" className="btn btn--go">{rule ? "Save" : "Add rule"}</button>
        {rule ? (
          <button type="submit" formAction={deletePricingRule} className="btn btn--quiet" formNoValidate>
            Delete
          </button>
        ) : null}
      </div>

      {rule ? (
        <p className="price-rule-summary" id={`rule-${id}`}>
          {rule.summary}
          <small>{lastChanged(rule)}</small>
        </p>
      ) : null}
    </form>
  );
}

function PreviewRow({ row }: { row: PricingPreviewRow }) {
  return (
    <tr>
      <td>{money(row.cost)}</td>
      <td>{row.price === null ? <em>Not shown</em> : <strong>{money(row.price)}</strong>}</td>
      <td>
        {row.rule_summary ? (
          <>
            {row.rule_summary}
            <small>{row.rule_from === "All stores" ? "From All stores" : "From this store"}</small>
          </>
        ) : (
          row.reason
        )}
      </td>
    </tr>
  );
}

async function Pricing({ params }: { params: Params }) {
  const scopeParam = one(params.scope);
  const scope = UUID_RE.test(scopeParam) ? scopeParam : "all";
  const product = one(params.product);
  const cost = one(params.cost);

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
      <p className="console-empty">
        {why ?? "Pricing is unavailable right now. Try again shortly."}{" "}
        {why ? <Link href="/admin/pricing">Back to All stores</Link> : null}
      </p>
    );
  }

  const flash = notice(params);
  const here = payload.scope.store_id;
  const keep = { product, cost };

  return (
    <>
      <header className="admin-head">
        <h1 className="console-title">Pricing</h1>
      </header>

      <p className="console-flash console-flash--bad price-warning" role="note">
        Changes apply right away, including to deals being presented now.
      </p>

      {flash ? (
        <p className={flash.tone === "ok" ? "console-flash" : "console-flash console-flash--bad"} role="status">
          {flash.text}
        </p>
      ) : null}

      <p className="console-note">
        {payload.stores.length > 0
          ? `The menu runs at: ${payload.stores.map((s) => s.name).join(", ")}.`
          : "The menu does not run at any store yet: no store has an active TecAssured account."}
      </p>

      <nav className="price-scopes" aria-label="Store">
        <Link
          href={scopeHref(null, keep)}
          className={`price-scope${here === null ? " is-here" : ""}`}
          aria-current={here === null ? "page" : undefined}
        >
          <span>All stores (default)</span>
          <small>{payload.all_stores_active_rules > 0 ? "Used by any store without its own rules" : "No rules yet"}</small>
        </Link>
        {payload.stores.map((s) => (
          <Link
            key={s.id}
            href={scopeHref(s.id, keep)}
            className={`price-scope${here === s.id ? " is-here" : ""}${s.status.startsWith("No pricing") ? " is-unpriced" : ""}`}
            aria-current={here === s.id ? "page" : undefined}
          >
            <span>{s.name}</span>
            <small>{s.status}</small>
          </Link>
        ))}
      </nav>

      <section className="setting price-section">
        <div className="setting-head">
          <h2>Rules for {payload.scope.name}</h2>
        </div>
        <p className="setting-note">
          {here === null
            ? "Any store without rules of its own uses these."
            : "This store uses these first. A cost they do not cover falls back to All stores."}{" "}
          A rule covers costs from its first number up to, but not including, its second, so one
          rule can end where the next begins. A product rule beats an All products rule.
        </p>

        <div className="price-grid">
          <div className="price-rule price-rule--head" aria-hidden="true">
            {COLUMNS.map((c, i) => <span key={i}>{c}</span>)}
          </div>
          {payload.rules.length === 0 ? (
            <p className="setting-help">
              {here === null
                ? "No rules yet."
                : payload.all_stores_active_rules > 0
                  ? "No rules of its own. It uses All stores."
                  : "No rules of its own, and All stores has none either. Its products will not be shown."}
            </p>
          ) : (
            payload.rules.map((r) => (
              <RuleForm key={r.id} rule={r} scope={scope} products={payload.products} />
            ))
          )}
          <p className="price-add-label">Add a rule</p>
          <RuleForm rule={null} scope={scope} products={payload.products} />
        </div>
      </section>

      {payload.rules.length > 0 && payload.copy_targets.length > 0 ? (
        <form action={copyPricingRules} className="setting price-copy">
          <input type="hidden" name="scope" value={scope} />
          <label>
            <span>Copy these rules to...</span>
            <select name="to_scope" defaultValue="">
              <option value="" disabled>Choose where</option>
              {payload.copy_targets.map((t) => (
                <option key={t.store_id ?? "all"} value={t.store_id ?? "all"} disabled={t.has_rules}>
                  {t.name}{t.has_rules ? " (already has rules)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn--quiet">Copy</button>
          <p className="setting-help">Only to a place with no rules, so nothing is overwritten.</p>
        </form>
      ) : null}

      <section className="setting price-section">
        <div className="setting-head">
          <h2>Preview</h2>
        </div>
        <p className="setting-note">
          What a customer would be shown at {payload.scope.name === "All stores" ? "a store using All stores" : payload.scope.name},
          priced exactly as the planner prices it.
        </p>
        <form method="get" action="/admin/pricing" className="price-preview-form">
          {here !== null ? <input type="hidden" name="scope" value={here} /> : null}
          <label>
            <span>Product</span>
            <select name="product" defaultValue={payload.preview.product_code ?? ""}>
              <option value="">Any product without its own rule</option>
              {payload.products.map((p) => (
                <option key={p.code} value={p.code}>{p.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Dealer cost</span>
            <input name="cost" inputMode="decimal" defaultValue={cost} placeholder="Any cost" />
          </label>
          <button type="submit" className="btn btn--quiet">Show</button>
        </form>
        <div className="console-scroll">
          <table className="console-table price-preview">
            <thead>
              <tr><th>Dealer cost</th><th>Customer price</th><th>Rule used</th></tr>
            </thead>
            <tbody>
              {payload.preview.rows.map((row) => <PreviewRow key={row.cost} row={row} />)}
              {payload.preview.typed ? <PreviewRow row={payload.preview.typed} /> : null}
            </tbody>
          </table>
        </div>
        {cost && !payload.preview.typed ? (
          <p className="setting-help">That cost could not be read. Type a number, for example 750.</p>
        ) : null}
      </section>

      <section className="setting price-section">
        <div className="setting-head">
          <h2>Gaps</h2>
        </div>
        {payload.gaps.length === 0 ? (
          <p className="setting-note">Every cost from $0 to $10,000 has a rule.</p>
        ) : (
          <ul className="price-gaps">
            {payload.gaps.map((g) => <li key={g.from}>{g.sentence}</li>)}
          </ul>
        )}
        <p className="setting-help">
          Checked for products without a rule of their own, after falling back to All stores.
        </p>
      </section>
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
