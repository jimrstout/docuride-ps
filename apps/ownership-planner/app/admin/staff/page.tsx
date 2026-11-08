// app/admin/staff/page.tsx: who sees which stores in DocuRide PS.
//
// Each sign-in, its PS role and its stores (migration 0058). An Administrator
// sees every store and manages this page; Staff see only the stores ticked
// here. Changing someone's role or stores records who made the change.
// Administrators only: anyone else is told so, and the list is not sent to
// them (fni-admin-sessions, section staff).

import { currentOperator } from "@/lib/admin-session";
import Control from "@/components/Control";
import { Working } from "@/components/Working";
import { edge, EdgeError } from "@/lib/edge";
import type { StaffPayload } from "@/lib/types";
import { saveStaffAccess } from "@/app/console-actions";
import { Notice, PageHead } from "@/components/admin/Parts";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;

const ROLES = ["Administrator", "Staff", "No access"] as const;

function notice(params: Params): { tone: "good" | "warn"; text: string } | null {
  if (params.saved !== undefined) return { tone: "good", text: "Saved." };
  if (typeof params.refused === "string") return { tone: "warn", text: params.refused };
  if (params.savefailed !== undefined) {
    return { tone: "warn", text: "That could not be saved just now. Nothing was changed. Try again shortly." };
  }
  return null;
}

export default async function StaffPage({ searchParams }: { searchParams: Promise<Params> }) {
  const operator = await currentOperator();
  if (!operator) return null;
  const params = await searchParams;

  let payload: StaffPayload;
  try {
    payload = await edge.adminStaff<StaffPayload>();
  } catch (err) {
    const refused = err instanceof EdgeError && err.status === 403;
    if (!refused) console.error("staff load failed:", err);
    return (
      <>
        <PageHead title="Staff" subtitle="Who sees which stores." />
        <Notice tone="warn">
          {refused ? "Only an administrator can change who sees which stores." : "Staff are unavailable right now. Try again shortly."}
        </Notice>
      </>
    );
  }

  const flash = notice(params);

  return (
    <>
      <PageHead title="Staff" subtitle="Who sees which stores." />
      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <section className="ad-panel" aria-label="Staff">
        <p className="ad-help ad-panel-intro">
          An Administrator sees every store and can change this page. Staff see only the stores ticked for them.
          No access means the sign-in cannot open DocuRide PS.
        </p>
        <div className="ad-scroll">
          <table className="ad-table" id="ad-staff">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Stores</th>
                <th scope="col"><span className="sr-only">Save</span></th>
              </tr>
            </thead>
            <tbody>
              {payload.people.map((p) => {
                const me = p.email.toLowerCase() === operator.email.toLowerCase();
                const form = `staff-${p.user_id}`;
                return (
                  <tr key={p.user_id}>
                    <td>
                      <span className="ad-strong">{p.email}</span>
                      {p.role_granted_by ? <small>Role set by {p.role_granted_by}</small> : null}
                    </td>
                    <td>
                      {me ? (
                        // Your own role is changed by another administrator.
                        <span>{p.role} (you)</span>
                      ) : (
                        <>
                          <label className="sr-only" htmlFor={`role-${p.user_id}`}>Role for {p.email}</label>
                          <select id={`role-${p.user_id}`} name="role" form={form} defaultValue={p.role}>
                            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </>
                      )}
                    </td>
                    <td>
                      {p.role === "Administrator" ? <small className="ad-staff-every">Sees every store.</small> : null}
                      <fieldset className="ad-staff-stores">
                        <legend className="sr-only">Stores for {p.email}</legend>
                        {payload.stores.map((s) => (
                          <label key={s.id} className="ad-staff-store" title={s.name}>
                            <input type="checkbox" name="store_id" value={s.id} form={form} defaultChecked={p.store_ids.includes(s.id)} />
                            <span>{s.name}</span>
                          </label>
                        ))}
                      </fieldset>
                    </td>
                    <td>
                      <form id={form} action={saveStaffAccess} className="ad-inline-form" data-working-panel="">
                        <Working />
                        <input type="hidden" name="user_id" value={p.user_id} />
                        {me ? <input type="hidden" name="self" value="1" /> : null}
                        <input type="hidden" name="role_before" value={p.role} />
                        <Control type="submit" className="ad-btn ad-btn--secondary" busyText="Saving...">Save</Control>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
