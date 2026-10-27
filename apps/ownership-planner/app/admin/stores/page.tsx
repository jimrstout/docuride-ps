// app/admin/stores/page.tsx: each store's time zone.
//
// A store's time zone decides when its day ends. A planning session stays open
// until 23:59:59 that day (or the planned sale date), and contracts can be
// submitted only when the deal's sale date is that day (migration 0038,
// supabase/functions/_shared/store-day.ts). Every store starts in Eastern
// time; a store in another zone is set here.
//
// Only the time zone is edited. A store's name and address come from the CRM.

import { currentOperator } from "@/lib/admin-session";
import PendingButton from "@/components/PendingButton";
import { Working } from "@/components/Working";
import { edge } from "@/lib/edge";
import { dayLabel } from "@/lib/store-time";
import type { StoresPayload } from "@/lib/types";
import { saveStoreTimeZone } from "@/app/console-actions";
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

  return (
    <>
      <PageHead title="Stores" subtitle="When each store's day ends." />
      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <section className="ad-panel" aria-label="Stores">
        <p className="ad-help ad-panel-intro">
          A planning session stays open until 11:59 PM in its store&apos;s time zone, and contracts
          can be submitted only on the day of the sale there. Pick the zone each store is in.
        </p>
        <div className="ad-scroll">
          <table className="ad-table" id="ad-stores">
            <thead>
              <tr>
                <th scope="col">Store</th>
                <th scope="col">Time zone</th>
                <th scope="col">Today there</th>
              </tr>
            </thead>
            <tbody>
              {payload.stores.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="ad-strong">{s.name}</span>
                    {s.place ? <small>{s.place}</small> : null}
                  </td>
                  <td>
                    <form action={saveStoreTimeZone} className="ad-inline-form" data-working-panel="">
                      <Working />
                      <input type="hidden" name="store_id" value={s.id} />
                      <label className="sr-only" htmlFor={`tz-${s.id}`}>Time zone for {s.name}</label>
                      <select id={`tz-${s.id}`} name="time_zone" defaultValue={s.time_zone}>
                        {payload.time_zones.map((z) => (
                          <option key={z.zone} value={z.zone}>{z.label}</option>
                        ))}
                      </select>
                      <PendingButton className="ad-btn ad-btn--secondary" pending="Saving...">Save</PendingButton>
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
