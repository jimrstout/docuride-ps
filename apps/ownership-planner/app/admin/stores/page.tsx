// app/admin/stores/page.tsx: each store's time zone.
//
// A store's time zone decides when its day ends. A planning session stays open
// until 23:59:59 that day (or the planned sale date), and contracts can be
// submitted only when the deal's sale date is that day (migration 0038,
// supabase/functions/_shared/store-day.ts). Every store starts in Eastern
// time; a store in another zone is set here.
//
// Edited here, kept in fni.ps_stores (migration 0059): whether the store
// uses DocuRide PS, and its time zone. A store's name and address come from
// the CRM; the name shown is the CRM's full one. The page lists the stores
// using PS, and every store under Show all stores.

import { currentOperator } from "@/lib/admin-session";
import Control from "@/components/Control";
import { Working } from "@/components/Working";
import { edge } from "@/lib/edge";
import { dayLabel } from "@/lib/store-time";
import type { StoresPayload } from "@/lib/types";
import { saveStoreTimeZone } from "@/app/console-actions";
import UsesPsSwitch from "@/components/admin/UsesPsSwitch";
import { Notice, PageHead } from "@/components/admin/Parts";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;

function notice(params: Params): { tone: "good" | "warn"; text: string } | null {
  if (params.saved !== undefined) return { tone: "good", text: "Saved." };
  if (typeof params.refused === "string") return { tone: "warn", text: params.refused };
  if (params.savefailed !== undefined) {
    return { tone: "warn", text: "That could not be saved just now. Nothing was changed. Try again shortly." };
  }
  return null;
}

export default async function StoresPage({ searchParams }: { searchParams: Promise<Params> }) {
  // The layout shows the sign-in form to anyone not signed in. Checked here as
  // well, so nothing is fetched for them.
  const operator = await currentOperator();
  if (!operator) return null;
  const params = await searchParams;

  let payload: StoresPayload;
  try {
    payload = await edge.adminStores<StoresPayload>();
  } catch (err) {
    console.error("stores load failed:", err);
    return (
      <>
        <PageHead title="Stores" subtitle="When each store's day ends." />
        <Notice tone="warn">Stores are unavailable right now. Try again shortly.</Notice>
      </>
    );
  }

  const flash = notice(params);
  // Only the stores using PS, unless every store was asked for.
  const showingAll = params.all === "1";
  const shown = showingAll ? payload.stores : payload.stores.filter((s) => s.uses_ps);

  return (
    <>
      <PageHead title="Stores" subtitle="When each store's day ends." />
      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <section className="ad-panel" aria-label="Stores">
        <div className="ad-panel-intro ad-stores-intro">
          <p className="ad-help">
            A planning session stays open until 11:59 PM in its store&apos;s time zone, and contracts
            can be submitted only on the day of the sale there. Pick the zone each store is in. A deal
            can start DocuRide PS only at a store that uses it.
          </p>
          <Control className="ad-btn ad-btn--secondary" href={showingAll ? "/admin/stores" : "/admin/stores?all=1"}>
            {showingAll ? "Show only stores using DocuRide PS" : `Show all stores (${payload.stores.length})`}
          </Control>
        </div>
        <div className="ad-scroll">
          <table className="ad-table ad-table--compact" id="ad-stores">
            <thead>
              <tr>
                <th scope="col">Store</th>
                <th scope="col">DocuRide PS</th>
                <th scope="col">Time zone</th>
                <th scope="col">Today there</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={4} className="ad-empty">
                    No store uses DocuRide PS yet. Show all stores to turn one on.
                  </td>
                </tr>
              ) : null}
              {shown.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="ad-strong">{s.name}</span>
                    {s.place ? <small>{s.place}</small> : null}
                    {(s.same_dealer ?? []).map((other) => (
                      <small key={other} className="ad-same-dealer">Same dealer as {other}</small>
                    ))}
                  </td>
                  <td>
                    <UsesPsSwitch storeId={s.id} storeName={s.name} on={s.uses_ps === true} showingAll={showingAll} />
                  </td>
                  <td>
                    <form action={saveStoreTimeZone} className="ad-inline-form" data-working-panel="">
                      <Working />
                      <input type="hidden" name="store_id" value={s.id} />
                      {showingAll ? <input type="hidden" name="all" value="1" /> : null}
                      <label className="sr-only" htmlFor={`tz-${s.id}`}>Time zone for {s.name}</label>
                      <select id={`tz-${s.id}`} name="time_zone" defaultValue={s.time_zone}>
                        {payload.time_zones.map((z) => (
                          <option key={z.zone} value={z.zone}>{z.label}</option>
                        ))}
                      </select>
                      <Control type="submit" className="ad-btn ad-btn--secondary" busyText="Saving...">Save</Control>
                    </form>
                  </td>
                  <td className="ad-today" style={{ whiteSpace: "nowrap" }}>{dayLabel(s.today)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
