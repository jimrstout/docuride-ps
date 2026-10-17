// app/admin/price-sheets/page.tsx: the OEM programs' rate sheets.
//
// A Price Sheet provider (BRP, Kawasaki, Honda, Indian Motorcycle, Polaris ORV)
// has no API. Its rates come from a sheet uploaded here: Claude reads it into
// rates, the server checks flag anything that looks wrong, staff review it, and
// a person publishes it. A parse is always a Draft.
//
// Choose a provider (?provider=<id>) to see its sheets; open a sheet to review
// and publish it.

import Link from "next/link";
import { currentOperator } from "@/lib/admin-session";
import { edge, EdgeError } from "@/lib/edge";
import type { PriceSheetRow, ProvidersPayload } from "@/lib/types";
import SheetUpload from "@/components/admin/SheetUpload";
import { Badge, Notice, PageHead } from "@/components/admin/Parts";
import { dateLine, statusTone } from "@/lib/price-sheets";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function PriceSheetsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const operator = await currentOperator();
  if (!operator) return null;
  const params = await searchParams;

  let providers: ProvidersPayload["providers"];
  let sheets: PriceSheetRow[] = [];
  try {
    providers = (await edge.adminProviders<ProvidersPayload>()).providers.filter((p) => p.kind === "Price Sheet");
    const chosenId = one(params.provider) || providers[0]?.id || "";
    if (chosenId) sheets = (await edge.priceSheets<{ sheets: PriceSheetRow[] }>({ provider_id: chosenId })).sheets;
  } catch (err) {
    console.error("price sheets load failed:", err);
    const why = err instanceof EdgeError && err.status === 400 ? err.message : null;
    return (
      <>
        <PageHead title="Price sheets" subtitle="Rates for the OEM programs, read from their sheets." />
        <Notice tone="warn">{why ?? "Price sheets are unavailable right now. Try again shortly."}</Notice>
      </>
    );
  }

  const chosen = providers.find((p) => p.id === one(params.provider)) ?? providers[0] ?? null;

  return (
    <>
      <PageHead title="Price sheets" subtitle="Rates for the OEM programs, read from their sheets." />
      {typeof params.refused === "string" ? <Notice tone="warn">{params.refused}</Notice> : null}
      {params.savefailed !== undefined ? (
        <Notice tone="warn">That could not be saved just now. Nothing was changed. Try again shortly.</Notice>
      ) : null}

      {providers.length === 0 ? (
        <Notice tone="warn">There is no Price Sheet provider yet. Add one under Providers first.</Notice>
      ) : (
        <>
          <nav className="ad-seg" aria-label="Provider">
            {providers.map((p) => (
              <Link
                key={p.id}
                href={`/admin/price-sheets?provider=${p.id}`}
                prefetch={false}
                className={chosen?.id === p.id ? "is-here" : undefined}
                aria-current={chosen?.id === p.id ? "page" : undefined}
              >
                <span className={p.sheets.some((s) => s.status === "Published") ? "ad-dot ad-dot--good" : "ad-dot ad-dot--none"} aria-hidden="true" />
                <span>{p.name}</span>
              </Link>
            ))}
          </nav>

          <section className="ad-panel" aria-labelledby="sheets-title">
            <div className="ad-panel-head"><h2 id="sheets-title">{chosen?.name}&apos;s sheets</h2></div>
            <div className="ad-scroll">
              <table className="ad-table">
                <thead>
                  <tr>
                    <th scope="col">Sheet</th>
                    <th scope="col">In force</th>
                    <th scope="col">Status</th>
                    <th scope="col">Reading</th>
                    <th scope="col">Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {sheets.length === 0 ? (
                    <tr><td colSpan={5} className="ad-empty">No sheets yet. Upload one below.</td></tr>
                  ) : null}
                  {sheets.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link href={`/admin/price-sheets/${s.id}`} prefetch={false} className="ad-strong">{s.name}</Link>
                        <small>{s.file_name}</small>
                      </td>
                      <td>{dateLine(s)}</td>
                      <td><Badge tone={statusTone(s)}>{s.status}</Badge></td>
                      <td>{s.parse_status}</td>
                      <td>{s.uploaded_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="ad-panel ad-editor" aria-labelledby="upload-title">
            <div className="ad-panel-head"><h2 id="upload-title">Upload a sheet</h2></div>
            <div className="ad-panel-body">
              <SheetUpload providers={providers.map((p) => ({ id: p.id, name: p.name }))} chosen={chosen?.id ?? ""} />
            </div>
          </section>
        </>
      )}
    </>
  );
}
