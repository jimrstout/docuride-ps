// app/admin/providers/page.tsx: who the menu's products come from.
//
// Riders Advantage is rated and contracted through the TecAssured API. The OEM
// programs (BRP, Kawasaki, Honda, Indian Motorcycle, Polaris ORV, and any added
// here) are rated from price sheets and their contracts are recorded by staff.
//
// A provider added here is always a Price Sheet provider: one rated through an
// API needs code. Which stores sell a Price Sheet provider's program is set
// here. A Connected provider's store accounts carry a login and a Dealer ID,
// so they are shown and set up by DocuRide staff; the database checks every
// store account against its provider either way (migration 0026).
//
// Nothing is deleted: a provider is switched off. Edit opens one form under the
// table (?edit=<id>), so the page works with no JavaScript.

import Link from "next/link";
import { currentOperator } from "@/lib/admin-session";
import { edge, EdgeError } from "@/lib/edge";
import type { ProviderRow, ProvidersPayload } from "@/lib/types";
import { addProvider, saveProvider, setProviderStores } from "@/app/console-actions";
import { Badge, Notice, PageHead } from "@/components/admin/Parts";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

function notice(params: Params): { tone: "good" | "warn"; text: string } | null {
  if (params.saved !== undefined) return { tone: "good", text: "Saved. It applies to the next deal rated." };
  if (params.added !== undefined) return { tone: "good", text: "Added. Choose the stores that sell it, then upload its price sheet." };
  if (typeof params.refused === "string") return { tone: "warn", text: params.refused };
  if (params.savefailed !== undefined) return { tone: "warn", text: "That could not be saved just now. Nothing was changed. Try again shortly." };
  return null;
}

function sheetLine(p: ProviderRow): string {
  if (p.kind === "Connected") return "Rated through its API.";
  const published = p.sheets.filter((s) => s.status === "Published");
  const drafts = p.sheets.filter((s) => s.status === "Draft").length;
  if (published.length > 0) return `Published: ${published.map((s) => s.name).join(", ")}.`;
  if (drafts > 0) return `${drafts} draft ${drafts === 1 ? "sheet" : "sheets"}, none published.`;
  return "No price sheet yet.";
}

function ProviderForm({ p, stores }: { p: ProviderRow | null; stores: ProvidersPayload["stores"] }) {
  return (
    <section className="ad-panel ad-editor" aria-labelledby="provider-form">
      <div className="ad-panel-head">
        <h2 id="provider-form">{p ? `Edit ${p.name}` : "Add a provider"}</h2>
      </div>
      <div className="ad-panel-body">
        <form action={p ? saveProvider : addProvider} className="ad-editor-fields">
          {p ? <input type="hidden" name="provider_id" value={p.id} /> : null}
          <label className="ad-field">
            <span>Name</span>
            <input name="name" defaultValue={p?.name ?? ""} required />
          </label>
          <label className="ad-field">
            <span>Makes its program covers</span>
            <input name="makes" defaultValue={p?.makes.join(", ") ?? ""} placeholder="Can-Am, Sea-Doo" />
          </label>
          <label className="ad-field ad-field--wide">
            <span>Notes</span>
            <input name="notes" defaultValue={p?.notes ?? ""} />
          </label>
          {p ? (
            <label className="ad-check">
              <input type="checkbox" name="active" defaultChecked={p.active} /> Active
            </label>
          ) : (
            <p className="ad-help ad-field--wide">
              Added as a Price Sheet provider whose contracts are recorded by staff.
            </p>
          )}
          <div className="ad-editor-actions ad-field--wide">
            <button type="submit" className="ad-btn ad-btn--primary">{p ? "Save" : "Add provider"}</button>
            <Link href="/admin/providers" prefetch={false} className="ad-btn ad-btn--secondary">Cancel</Link>
          </div>
        </form>

        {p && p.kind === "Price Sheet" ? (
          <form action={setProviderStores} className="ad-form">
            <input type="hidden" name="provider_id" value={p.id} />
            <h3>Stores that sell {p.name}</h3>
            <div className="ad-checks">
              {stores.map((s) => (
                <label key={s.id} className="ad-check">
                  <input
                    type="checkbox"
                    name="store_ids"
                    value={s.id}
                    defaultChecked={p.stores.some((a) => a.store_id === s.id && a.active)}
                  />{" "}
                  {s.name}
                </label>
              ))}
            </div>
            <button type="submit" className="ad-btn ad-btn--secondary">Save stores</button>
          </form>
        ) : p ? (
          <p className="ad-help">
            {p.name}&apos;s store accounts carry a login and a Dealer ID, so DocuRide staff set them up.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default async function ProvidersPage({ searchParams }: { searchParams: Promise<Params> }) {
  // The layout shows the sign-in form to anyone not signed in. Checked here as
  // well, so nothing is fetched for them.
  const operator = await currentOperator();
  if (!operator) return null;
  const params = await searchParams;
  const editing = one(params.edit);
  const adding = params.add !== undefined;

  let payload: ProvidersPayload;
  try {
    payload = await edge.adminProviders<ProvidersPayload>();
  } catch (err) {
    console.error("providers load failed:", err);
    const why = err instanceof EdgeError && err.status === 400 ? err.message : null;
    return (
      <>
        <PageHead title="Providers" subtitle="Who the menu's products come from." />
        <Notice tone="warn">{why ?? "Providers are unavailable right now. Try again shortly."}</Notice>
      </>
    );
  }

  const flash = notice(params);
  const edit = editing ? payload.providers.find((p) => p.id === editing) ?? null : null;

  return (
    <>
      <PageHead title="Providers" subtitle="Who the menu's products come from.">
        <Link href="/admin/providers?add=1" prefetch={false} className="ad-btn ad-btn--primary">Add a provider</Link>
      </PageHead>
      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <section className="ad-panel" aria-label="Providers">
        <div className="ad-scroll">
          <table className="ad-table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">How it is rated</th>
                <th scope="col">Makes</th>
                <th scope="col">Stores</th>
                <th scope="col">Price sheets</th>
                <th scope="col"><span className="sr-only">Edit</span></th>
              </tr>
            </thead>
            <tbody>
              {payload.providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="ad-strong">{p.name}</span>{" "}
                    {p.active ? null : <Badge>Off</Badge>}
                    <small>{p.contract_method === "Through API" ? "Contracts through its API" : "Contracts recorded by staff"}</small>
                  </td>
                  <td>{p.kind === "Connected" ? `Connected (${p.adapter})` : "Price Sheet"}</td>
                  <td>{p.makes.length > 0 ? p.makes.join(", ") : "Any make"}</td>
                  <td>
                    {p.stores.filter((s) => s.active).map((s) => s.name).join(", ") || "None yet"}
                  </td>
                  <td>{sheetLine(p)}</td>
                  <td className="num">
                    <Link href={`/admin/providers?edit=${p.id}`} prefetch={false} className="ad-btn ad-btn--secondary">Edit</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {edit || adding ? <ProviderForm p={edit} stores={payload.stores} /> : null}
    </>
  );
}
