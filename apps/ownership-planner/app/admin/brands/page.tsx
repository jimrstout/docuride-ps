// app/admin/brands/page.tsx: brands, parent companies and the provider's spellings.
//
// The CRM's make is whatever someone typed. PS matches it to one of these
// brands, ignoring case, spaces and punctuation, and asks staff on Details
// when it cannot (supabase/functions/_shared/brands.ts, migration 0056).
//
//   Brands            what staff choose from, with other spellings that mean
//                     the same brand.
//   Parent companies  a parent name (BRP, Polaris) never maps by itself. It
//                     narrows the choice to its brands for the vehicle type.
//                     A brand marked preferred is pre-selected for those types,
//                     and staff still confirm it.
//   Provider spellings the spelling each provider server accepts. QA and live
//                     are separate. The provider's own makes list is shown for
//                     reference; a spelling saved here wins over it.
//
// The CRM is never changed.

import { currentOperator } from "@/lib/admin-session";
import Control from "@/components/Control";
import { Working } from "@/components/Working";
import { edge } from "@/lib/edge";
import type { BrandsPayload } from "@/lib/types";
import { removeBrandGroup, removeBrandSpelling, saveBrand, saveBrandGroup, saveBrandSpelling } from "@/app/console-actions";
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

const SERVER: Record<string, string> = { Test: "QA", Live: "Live" };

export default async function BrandsPage({ searchParams }: { searchParams: Promise<Params> }) {
  // The layout shows the sign-in form to anyone not signed in. Checked here as
  // well, so nothing is fetched for them.
  const operator = await currentOperator();
  if (!operator) return null;
  const params = await searchParams;

  let payload: BrandsPayload;
  try {
    payload = await edge.adminBrands<BrandsPayload>();
  } catch (err) {
    console.error("brands load failed:", err);
    return (
      <>
        <PageHead title="Brands" subtitle="The brand a deal's make names, and how each provider spells it." />
        <Notice tone="warn">Brands are unavailable right now. Try again shortly.</Notice>
      </>
    );
  }

  const flash = notice(params);
  const brandNames = payload.brands.map((b) => b.name);
  const providerName = (id: string) => payload.providers.find((p) => p.id === id)?.name ?? "Provider";
  const parents = [...new Set(payload.groups.map((g) => g.parent_name))];
  // The provider's own list, one line per provider, server and vehicle type.
  const lists = new Map<string, { label: string; makes: string[]; fetched: string }>();
  for (const m of payload.provider_makes) {
    const key = `${m.provider_id}|${m.environment}|${m.vtype}`;
    const row = lists.get(key) ?? { label: `${providerName(m.provider_id)}, ${SERVER[m.environment] ?? m.environment}, ${m.vtype}`, makes: [], fetched: m.fetched_at };
    if (!row.makes.includes(m.make)) row.makes.push(m.make);
    lists.set(key, row);
  }

  return (
    <>
      <PageHead title="Brands" subtitle="The brand a deal's make names, and how each provider spells it." />
      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <section className="ad-panel" aria-label="Brands">
        <h2>Brands</h2>
        <p className="ad-help ad-panel-intro">
          A make in the CRM matches a brand by its name or another spelling, ignoring case, spaces, hyphens and
          punctuation. Separate other spellings with semicolons. A make that matches nothing waits on Details for
          staff to pick the brand.
        </p>
        <div id="ad-brands">
          {payload.brands.map((b) => (
            <form key={b.id} action={saveBrand} className="ad-inline-form" data-working-panel="">
              <Working />
              <input type="hidden" name="id" value={b.id} />
              <input type="hidden" name="name" value={b.name} />
              <span className="ad-strong" style={{ minWidth: "10rem" }}>{b.name}</span>
              <label className="sr-only" htmlFor={`ba-${b.id}`}>Other spellings of {b.name}</label>
              <input id={`ba-${b.id}`} name="aliases" defaultValue={b.aliases.join("; ")} placeholder="No other spellings" />
              <label className="ad-check">
                <input type="checkbox" name="active" defaultChecked={b.active} /> Offered
              </label>
              <Control type="submit" className="ad-btn ad-btn--secondary" busyText="Saving...">Save</Control>
            </form>
          ))}
        </div>
        <form action={saveBrand} className="ad-form">
          <Working />
          <h3>Add a brand</h3>
          <label className="ad-field">
            <span>Brand</span>
            <input name="name" required maxLength={60} placeholder="Triumph" />
          </label>
          <label className="ad-field">
            <span>Other spellings, separated by semicolons</span>
            <input name="aliases" placeholder="Triumph Motorcycles" />
          </label>
          <input type="hidden" name="active" value="on" />
          <div className="ad-editor-actions ad-field--wide">
            <Control type="submit" className="ad-btn ad-btn--primary" busyText="Adding...">Add brand</Control>
          </div>
        </form>
      </section>

      <section className="ad-panel" aria-label="Parent companies">
        <h2>Parent companies</h2>
        <p className="ad-help ad-panel-intro">
          A parent company never becomes a brand by itself. On Details it narrows the choice to its brands for the
          deal&apos;s vehicle type. When one brand is left, or one is marked preferred for that type, it is
          pre-selected and marked &quot;Check the brand&quot;, and staff confirm it before rating. A brand with no
          vehicle types ticked covers every type.
        </p>
        {parents.map((parent) => (
          <div key={parent}>
            <h3>{parent}</h3>
            <div className="ad-scroll">
              <table className="ad-table">
                <thead>
                  <tr>
                    <th scope="col">Brand</th>
                    <th scope="col">Vehicle types</th>
                    <th scope="col">Preferred</th>
                    <th scope="col">Note</th>
                    <th scope="col">Changed</th>
                    <th scope="col"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {payload.groups.filter((g) => g.parent_name === parent).map((g) => (
                    <tr key={g.id}>
                      <td className="ad-strong">{g.brand_name}</td>
                      <td>{g.vehicle_types.length > 0 ? g.vehicle_types.join(", ") : "Every type"}</td>
                      <td>{g.preferred ? "Yes" : "No"}</td>
                      <td>{g.note ?? ""}</td>
                      <td><small>{g.updated_by ?? ""}</small></td>
                      <td>
                        <form action={removeBrandGroup} className="ad-inline-form" data-working-panel="">
                          <Working />
                          <input type="hidden" name="id" value={g.id} />
                          <Control type="submit" className="ad-btn ad-btn--secondary" busyText="Removing...">Remove</Control>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        <form action={saveBrandGroup} className="ad-form">
          <Working />
          <h3>Add a brand to a parent company</h3>
          <label className="ad-field">
            <span>Parent company</span>
            <input name="parent_name" required placeholder="BRP" list="ad-parents" />
            <datalist id="ad-parents">
              {parents.map((p) => <option key={p} value={p} />)}
            </datalist>
          </label>
          <label className="ad-field">
            <span>Brand</span>
            <select name="brand_name" required defaultValue="">
              <option value="" disabled>Choose a brand</option>
              {brandNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <fieldset className="ad-field ad-field--wide">
            <legend>Vehicle types it covers</legend>
            <div className="ad-checks">
              {payload.vehicle_types.map((t) => (
                <label key={t} className="ad-check">
                  <input type="checkbox" name="vehicle_types" value={t} /> {t}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="ad-check">
            <input type="checkbox" name="preferred" /> Preferred for those types
          </label>
          <label className="ad-field ad-field--wide">
            <span>Note</span>
            <input name="note" />
          </label>
          <div className="ad-editor-actions ad-field--wide">
            <Control type="submit" className="ad-btn ad-btn--primary" busyText="Saving...">Save</Control>
          </div>
        </form>
      </section>

      <section className="ad-panel" aria-label="Provider spellings">
        <h2>Provider spellings</h2>
        <p className="ad-help ad-panel-intro">
          Rating sends the provider its own spelling of the brand: one saved here first, then the matching make on
          the provider&apos;s own list, then the brand&apos;s name. QA and live are kept apart, so a spelling
          proved on QA is not assumed for live.
        </p>
        <div className="ad-scroll">
          <table className="ad-table" id="ad-spellings">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Server</th>
                <th scope="col">Vehicle type</th>
                <th scope="col">Brand</th>
                <th scope="col">Spelling sent</th>
                <th scope="col">From</th>
                <th scope="col"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {payload.spellings.length === 0 ? (
                <tr><td colSpan={7}>No spellings saved. The provider&apos;s own list is used.</td></tr>
              ) : payload.spellings.map((s) => (
                <tr key={s.id}>
                  <td>{providerName(s.provider_id)}</td>
                  <td>{SERVER[s.environment] ?? s.environment}</td>
                  <td>{s.vtype}</td>
                  <td className="ad-strong">{s.brand_name}</td>
                  <td>{s.spelling}</td>
                  <td>{s.source}{s.updated_by ? <small>{s.updated_by}</small> : null}</td>
                  <td>
                    <form action={removeBrandSpelling} className="ad-inline-form" data-working-panel="">
                      <Working />
                      <input type="hidden" name="id" value={s.id} />
                      <Control type="submit" className="ad-btn ad-btn--secondary" busyText="Removing...">Remove</Control>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {payload.providers.length > 0 ? (
          <form action={saveBrandSpelling} className="ad-form">
            <Working />
            <h3>Save a spelling</h3>
            <label className="ad-field">
              <span>Provider</span>
              <select name="provider_id" required defaultValue={payload.providers[0].id}>
                {payload.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="ad-field">
              <span>Server</span>
              <select name="environment" required defaultValue="Test">
                <option value="Test">QA</option>
                <option value="Live">Live</option>
              </select>
            </label>
            <label className="ad-field">
              <span>Provider&apos;s vehicle type code</span>
              <input name="vtype" required placeholder="MCYC" maxLength={10} />
            </label>
            <label className="ad-field">
              <span>Brand</span>
              <select name="brand_name" required defaultValue="">
                <option value="" disabled>Choose a brand</option>
                {brandNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="ad-field">
              <span>Spelling the provider accepts</span>
              <input name="spelling" required maxLength={60} placeholder="Indian Motorcycle" />
            </label>
            <label className="ad-field">
              <span>Note</span>
              <input name="note" />
            </label>
            <div className="ad-editor-actions ad-field--wide">
              <Control type="submit" className="ad-btn ad-btn--primary" busyText="Saving...">Save spelling</Control>
            </div>
          </form>
        ) : null}

        <h3>The provider&apos;s own makes list</h3>
        {lists.size === 0 ? (
          <p className="ad-help">Not fetched yet. The first rating on each server fetches it, and it is refreshed weekly.</p>
        ) : (
          <div className="ad-scroll">
            <table className="ad-table" id="ad-provider-makes">
              <thead>
                <tr>
                  <th scope="col">Provider, server, type</th>
                  <th scope="col">Makes</th>
                </tr>
              </thead>
              <tbody>
                {[...lists.entries()].map(([key, row]) => (
                  <tr key={key}>
                    <td style={{ whiteSpace: "nowrap" }}>{row.label}</td>
                    <td>{row.makes.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
