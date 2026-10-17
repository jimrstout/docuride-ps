// app/admin/providers/wording/page.tsx: Providers, Product wording.
//
// The words a customer reads about each of a provider's products. A product an
// OEM price sheet adds to the catalog arrives with a name and a category and
// nothing else, so the planner does not show it until a person writes these
// answers here, checked against the provider's approved language. Nothing on
// this page is generated.
//
// Choose a provider (?provider=<id>) to see its products; choose a product
// (&product=<id>) to open its form under the table.

import Link from "next/link";
import { currentOperator } from "@/lib/admin-session";
import { edge, EdgeError } from "@/lib/edge";
import type { ProvidersPayload, WordingProductRow } from "@/lib/types";
import { saveWording } from "@/app/console-actions";
import { Badge, Notice, PageHead } from "@/components/admin/Parts";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

const GOALS = ["Keep ownership manageable", "Keep ownership enjoyable", "Keep the asset valuable"];

/** The questions, in the order the planner answers them for the customer. */
const QUESTIONS: { name: keyof WordingProductRow; label: string; needed: boolean }[] = [
  { name: "what_it_accomplishes", label: "What it accomplishes", needed: true },
  { name: "what_it_covers", label: "What it covers", needed: true },
  { name: "coverage_duration", label: "How long it lasts", needed: true },
  { name: "what_it_excludes", label: "What it excludes", needed: true },
  { name: "deductible_note", label: "About the deductible", needed: false },
  { name: "how_to_use", label: "How to use it", needed: true },
  { name: "transfer_note", label: "About transferring it", needed: false },
  { name: "future_value_note", label: "What it does for resale", needed: false },
];

function WordingForm({ p }: { p: WordingProductRow }) {
  return (
    <section className="ad-panel ad-editor" aria-labelledby="wording-form">
      <div className="ad-panel-head">
        <h2 id="wording-form">{p.display_name}</h2>
      </div>
      <div className="ad-panel-body">
        <form action={saveWording} className="ad-editor-fields">
          <input type="hidden" name="provider_id" value={p.provider_id} />
          <input type="hidden" name="product_id" value={p.id} />
          <label className="ad-field">
            <span>Name customers see</span>
            <input name="display_name" defaultValue={p.display_name} required />
          </label>
          <label className="ad-field">
            <span>Goal it serves</span>
            <select name="goal" defaultValue={p.goal}>
              {GOALS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          {QUESTIONS.map((q) => (
            <label key={q.name} className="ad-field ad-field--wide">
              <span>{q.label}{q.needed ? "" : " (optional)"}</span>
              <textarea name={q.name} rows={3} defaultValue={(p[q.name] as string | null) ?? ""} />
            </label>
          ))}
          <label className="ad-field">
            <span>Transfers to the next owner</span>
            <select name="transferable" defaultValue={p.transferable === null ? "" : p.transferable ? "Yes" : "No"}>
              <option value="">Not answered yet</option>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
            </select>
          </label>
          <label className="ad-field">
            <span>Link to the full terms</span>
            <input name="full_terms_url" type="url" defaultValue={p.full_terms_url ?? ""} placeholder="https://" />
          </label>
          <label className="ad-check">
            <input type="checkbox" name="active" defaultChecked={p.active} /> Active
          </label>
          <div className="ad-editor-actions ad-field--wide">
            <button type="submit" className="ad-btn ad-btn--primary">Save wording</button>
            <Link href={`/admin/providers/wording?provider=${p.provider_id}`} prefetch={false} className="ad-btn ad-btn--secondary">Cancel</Link>
            <p className="ad-help">
              Write these from the provider&apos;s approved language. The planner shows a product only when every answer
              that is not optional is written, it says whether it transfers, it links to the full terms, and it is active.
            </p>
          </div>
        </form>
      </div>
    </section>
  );
}

export default async function WordingPage({ searchParams }: { searchParams: Promise<Params> }) {
  const operator = await currentOperator();
  if (!operator) return null;
  const params = await searchParams;

  let providers: ProvidersPayload["providers"];
  let products: WordingProductRow[] = [];
  const subtitle = "The words a customer reads about each product. Written by a person, never generated.";
  try {
    providers = (await edge.adminProviders<ProvidersPayload>()).providers;
    const chosenId = one(params.provider) || providers[0]?.id || "";
    if (chosenId) products = (await edge.adminWording<{ products: WordingProductRow[] }>(chosenId)).products;
  } catch (err) {
    console.error("product wording load failed:", err);
    const why = err instanceof EdgeError && err.status === 400 ? err.message : null;
    return (
      <>
        <PageHead title="Product wording" subtitle={subtitle} />
        <Notice tone="warn">{why ?? "Product wording is unavailable right now. Try again shortly."}</Notice>
      </>
    );
  }

  const chosen = providers.find((p) => p.id === one(params.provider)) ?? providers[0] ?? null;
  const editing = products.find((p) => p.id === one(params.product)) ?? null;

  return (
    <>
      <PageHead title="Product wording" subtitle={subtitle}>
        <Link href="/admin/providers" prefetch={false} className="ad-btn ad-btn--secondary">Back to providers</Link>
      </PageHead>
      {params.saved !== undefined ? <Notice tone="good">Saved. The planner uses it on the next deal it opens.</Notice> : null}
      {typeof params.refused === "string" ? <Notice tone="warn">{params.refused}</Notice> : null}
      {params.savefailed !== undefined ? (
        <Notice tone="warn">That could not be saved just now. Nothing was changed. Try again shortly.</Notice>
      ) : null}

      <nav className="ad-seg" aria-label="Provider">
        {providers.map((p) => (
          <Link
            key={p.id}
            href={`/admin/providers/wording?provider=${p.id}`}
            prefetch={false}
            className={chosen?.id === p.id ? "is-here" : undefined}
            aria-current={chosen?.id === p.id ? "page" : undefined}
          >
            <span>{p.name}</span>
          </Link>
        ))}
      </nav>

      <section className="ad-panel" aria-labelledby="products-title">
        <div className="ad-panel-head"><h2 id="products-title">{chosen?.name}&apos;s products</h2></div>
        <div className="ad-scroll">
          <table className="ad-table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Category</th>
                <th scope="col">Planner</th>
                <th scope="col"><span className="sr-only">Edit</span></th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td colSpan={4} className="ad-empty">
                    No products yet. A provider&apos;s products are added when its first price sheet is published.
                  </td>
                </tr>
              ) : null}
              {products.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="ad-strong">{p.display_name}</span>
                    <small>{p.product_code}</small>
                  </td>
                  <td>{p.category}</td>
                  <td>
                    {p.missing.length === 0 ? (
                      <Badge tone="good">Shown</Badge>
                    ) : (
                      <>
                        <Badge tone="warn">Not shown</Badge>
                        <small>Needs {p.missing.join(", ")}.</small>
                      </>
                    )}
                  </td>
                  <td>
                    <Link
                      href={`/admin/providers/wording?provider=${p.provider_id}&product=${p.id}`}
                      prefetch={false}
                      className="ad-btn ad-btn--secondary"
                    >
                      Write wording
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing ? <WordingForm p={editing} /> : null}
    </>
  );
}
