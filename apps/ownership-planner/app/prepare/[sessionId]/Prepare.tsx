"use client";

// app/prepare/[sessionId]/Prepare.tsx: the Prepare menu screen.
//
// Columns across, categories down, and nothing scrolls. A cell shows its plan,
// option, price and profit; pressing it opens the editor: the plan and the
// option (term, mileage and deductible together, only what rated), dealer
// cost, the price, and the profit. A price belongs to the option, so editing
// it in one column changes it in every column that offers the same option.
// The vehicle's surcharges are chosen once, for the whole deal, and apply in
// every column. Each column's footer: total, profit and monthly payment.
//
// Saving checks the prices on the server. A price above the band needs a
// manager to sign in here and give a reason. Once the customer has chosen a
// package the prices are locked; returning to Prepare menu unlocks them and is
// recorded on the deal.

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { planTotals } from "@/lib/money";
import {
  cellFigures,
  columnFigures,
  dollars,
  findOption,
  initialState,
  needsManager,
  payloadOf,
  priceOf,
  readCents,
  surchargesOf,
  type PreparePayload,
  type PrepareState,
} from "@/lib/prepare-model";
import { savePreparedMenu, unlockPreparedMenu } from "./actions";

export default function Prepare({ initial }: { initial: PreparePayload }) {
  const [data, setData] = useState(initial);
  const [state, setState] = useState<PrepareState>(() => initialState(initial.sheet));
  const [editing, setEditing] = useState<{ pos: string; category: string } | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [manager, setManager] = useState({ email: "", password: "", reason: "" });
  // On a phone one column shows at a time, picked from tabs (prepare.css).
  const [tab, setTab] = useState(1);
  const cellDialog = useRef<HTMLDialogElement>(null);
  const surchargeDialog = useRef<HTMLDialogElement>(null);
  const managerDialog = useRef<HTMLDialogElement>(null);

  const { sheet, payment, session } = data;
  const locked = !!session.locked_at;

  const monthlyOf = (prices: number[]) =>
    payment.has_payment && payment.principal !== null && payment.rate !== null && payment.term_months !== null
      ? planTotals(payment.principal, prices, payment.rate, payment.term_months, payment.cap).planPayment
      : null;
  const footers = useMemo(
    () => sheet.columns.map((c) => columnFigures(sheet, state, String(c.position), monthlyOf)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet, state, payment]
  );
  const overBand = needsManager(sheet, state);

  const setCell = (pos: string, category: string, key: string | null) =>
    setState((s) => ({ ...s, cells: { ...s.cells, [pos]: { ...s.cells[pos], [category]: key } } }));
  const setPrice = (key: string, cents: number) => setState((s) => ({ ...s, prices: { ...s.prices, [key]: cents } }));
  const toggleSurcharge = (code: string) =>
    setState((s) => ({ ...s, surcharges: s.surcharges.includes(code) ? s.surcharges.filter((c) => c !== code) : [...s.surcharges, code] }));

  const save = (withManager: boolean) =>
    start(async () => {
      setMessage(null);
      const result = await savePreparedMenu(session.id, payloadOf(sheet, state), withManager ? manager : null);
      if (!result.ok) {
        setMessage({ tone: "bad", text: result.error });
        return;
      }
      managerDialog.current?.close();
      setManager({ email: "", password: "", reason: "" });
      setData(result.payload);
      setState(initialState(result.payload.sheet));
      setMessage({ tone: "ok", text: "Menu prepared. Present menu will use it." });
    });

  const onSave = () => {
    if (overBand.length > 0) managerDialog.current?.showModal();
    else save(false);
  };

  const unlock = () =>
    start(async () => {
      const result = await unlockPreparedMenu(session.id);
      if (!result.ok) return setMessage({ tone: "bad", text: result.error });
      setData(result.payload);
      setState(initialState(result.payload.sheet));
      setMessage({ tone: "ok", text: "Prices are unlocked. This is recorded on the deal." });
    });

  const open = (pos: string, category: string) => {
    if (locked) return;
    setEditing({ pos, category });
    cellDialog.current?.showModal();
  };

  const edited = editing ? findOption(sheet, state.cells[editing.pos]?.[editing.category] ?? null) : null;
  const editPlans = editing ? (sheet.plans[editing.category] ?? []).filter((p) => !p.purchased) : [];

  return (
    <div
      className="pm"
      data-tab={tab}
      style={{ ["--pm-rows" as string]: sheet.categories.length, ["--pm-cols" as string]: sheet.columns.length } as React.CSSProperties}
    >
      <header className="pm-head">
        <div>
          <p className="pm-eyebrow">Prepare menu{session.deal_number ? `, deal ${session.deal_number}` : ""}</p>
          <h1>{session.vehicle || "This deal"}</h1>
          <p className="pm-basis">
            {locked
              ? "The customer chose a package, so prices are locked."
              : session.prepared_at
                ? `Prepared by ${session.prepared_by ?? "staff"}. Present menu uses this.`
                : "Not prepared yet: Present menu uses the presets as they stand."}
          </p>
        </div>
        <div className="pm-actions">
          <button type="button" className="pm-btn" onClick={() => surchargeDialog.current?.showModal()} disabled={locked || pending}>
            Surcharges{state.surcharges.length > 0 ? ` (${state.surcharges.length})` : ""}
          </button>
          {locked ? (
            <button type="button" className="pm-btn pm-btn--go" onClick={unlock} disabled={pending}>Return to Prepare menu</button>
          ) : (
            <button type="button" className="pm-btn pm-btn--go" onClick={onSave} disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </button>
          )}
          <Link className="pm-btn pm-btn--quiet" href={`/details/${session.id}`} prefetch={false}>Details</Link>
        </div>
      </header>

      {message ? <p className={message.tone === "ok" ? "pm-note" : "pm-note pm-note--bad"} role="status">{message.text}</p> : null}

      <div className="pm-tabs" role="tablist" aria-label="Columns">
        {sheet.columns.map((c) => (
          <button key={c.position} type="button" role="tab" aria-selected={tab === c.position} className="pm-tab" onClick={() => setTab(c.position)}>
            {c.name}
          </button>
        ))}
      </div>

      <div className="pm-grid">
        <div className="pm-row pm-row--head">
          <span />
          {sheet.columns.map((c) => <div key={c.position} data-col={c.position} className="pm-colhead">{c.name}</div>)}
        </div>
        {sheet.categories.map((category) => (
          <div key={category} className="pm-row">
            <div className="pm-label">{category}</div>
            {sheet.columns.map((c) => {
              const pos = String(c.position);
              const bought = sheet.purchased.filter((p) => p.category === category);
              if (bought.length > 0) {
                return (
                  <div key={pos} data-col={pos} className="pm-cell pm-cell--locked">
                    <span className="pm-plan">{bought.map((b) => b.plan_name).join(", ")}</span>
                    <span className="pm-sub">Purchased, locked</span>
                    <span className="pm-price">{dollars(bought.reduce((n, b) => n + b.price, 0))}</span>
                  </div>
                );
              }
              const found = findOption(sheet, state.cells[pos]?.[category] ?? null);
              const note = sheet.cells[pos]?.[category]?.note ?? null;
              if (!found) {
                return (
                  <button key={pos} data-col={pos} type="button" className="pm-cell pm-cell--off" onClick={() => open(pos, category)} disabled={locked}>
                    <span className="pm-sub">{note ?? "Not included"}</span>
                  </button>
                );
              }
              const f = cellFigures(found.option, state);
              return (
                <button
                  key={pos}
                  data-col={pos}
                  type="button"
                  className={f.above_band ? "pm-cell pm-cell--over" : "pm-cell"}
                  onClick={() => open(pos, category)}
                  disabled={locked}
                  title={note ?? undefined}
                >
                  <span className="pm-plan">{found.plan.plan_name}</span>
                  <span className="pm-sub">{found.option.label}</span>
                  <span className="pm-price">{dollars(f.price)}</span>
                  <span className="pm-profit">Profit {dollars(f.profit)}</span>
                </button>
              );
            })}
          </div>
        ))}
        <div className="pm-row pm-row--foot">
          <span className="pm-label">Each column</span>
          {footers.map((f, i) => (
            <div key={i} data-col={i + 1} className="pm-foot">
              <span className="pm-total">{dollars(f.total)}</span>
              <span>Profit {dollars(f.profit)}</span>
              <span>{f.monthly === null ? "Cash deal: no payment" : `${dollars(f.monthly)} a month for protection`}</span>
            </div>
          ))}
        </div>
      </div>

      <dialog ref={cellDialog} className="pm-dialog" onClose={() => setEditing(null)}>
        {editing ? (
          <div className="pm-dialog-body">
            <h2>{sheet.columns.find((c) => String(c.position) === editing.pos)?.name}: {editing.category}</h2>
            <label className="pm-field">
              <span>Plan</span>
              <select
                value={edited ? `${edited.plan.provider_id}|${edited.plan.product_code}` : ""}
                onChange={(e) => {
                  const plan = editPlans.find((p) => `${p.provider_id}|${p.product_code}` === e.target.value);
                  setCell(editing.pos, editing.category, plan ? plan.options[0].key : null);
                }}
              >
                <option value="">Not included</option>
                {editPlans.map((p) => (
                  <option key={`${p.provider_id}|${p.product_code}`} value={`${p.provider_id}|${p.product_code}`}>{p.plan_name}</option>
                ))}
              </select>
            </label>
            {edited ? (
              <>
                <label className="pm-field">
                  <span>Term, mileage and deductible</span>
                  <select value={edited.option.key} onChange={(e) => setCell(editing.pos, editing.category, e.target.value)}>
                    {edited.plan.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                </label>
                <dl className="pm-figures">
                  <div><dt>Dealer cost</dt><dd>{dollars(edited.option.dealer_cost)}</dd></div>
                  <div>
                    <dt>Price</dt>
                    <dd>
                      <input
                        key={edited.option.key}
                        inputMode="decimal"
                        defaultValue={(() => {
                          const p = priceOf(edited.option, state);
                          return p === null ? "" : (p / 100).toFixed(2);
                        })()}
                        aria-label="Price, before surcharges"
                        onChange={(e) => {
                          const c = readCents(e.target.value);
                          if (c !== null) setPrice(edited.option.key, c);
                        }}
                      />
                    </dd>
                  </div>
                  <div><dt>Profit</dt><dd>{dollars(cellFigures(edited.option, state).profit)}</dd></div>
                </dl>
                {surchargesOf(edited.option, state) > 0 ? (
                  <p className="pm-help">
                    With this vehicle&apos;s surcharges at dealer cost ({dollars(surchargesOf(edited.option, state))}), the
                    customer pays {dollars(cellFigures(edited.option, state).price)}.
                  </p>
                ) : null}
                <p className="pm-help">
                  Staff may price from {dollars(edited.option.band.floor)} to {dollars(edited.option.band.top)}, before
                  surcharges. Above that needs a manager. Never below dealer cost. This price applies in every column
                  that offers {edited.plan.plan_name}, {edited.option.label}.
                  {cellFigures(edited.option, state).below_floor ? " This price is too low, so it will not save." : ""}
                </p>
              </>
            ) : null}
            <div className="pm-dialog-actions">
              <button type="button" className="pm-btn pm-btn--go" onClick={() => cellDialog.current?.close()}>Done</button>
            </div>
          </div>
        ) : null}
      </dialog>

      <dialog ref={surchargeDialog} className="pm-dialog">
        <div className="pm-dialog-body">
          <h2>Surcharges for this vehicle</h2>
          <p className="pm-help">Set once for the deal. Each applies in every column, wherever the product offers it, at its dealer cost.</p>
          {sheet.surcharges.available.length === 0 ? <p>None are offered on this vehicle.</p> : null}
          {sheet.surcharges.available.map((s) => (
            <label key={s.code} className="pm-check">
              <input type="checkbox" checked={state.surcharges.includes(s.code)} onChange={() => toggleSurcharge(s.code)} /> {s.label}
            </label>
          ))}
          <div className="pm-dialog-actions">
            <button type="button" className="pm-btn pm-btn--go" onClick={() => surchargeDialog.current?.close()}>Done</button>
          </div>
        </div>
      </dialog>

      <dialog ref={managerDialog} className="pm-dialog">
        <form
          className="pm-dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            save(true);
          }}
        >
          <h2>A manager must approve</h2>
          <p className="pm-help">
            {overBand.length === 1 ? "One price is" : `${overBand.length} prices are`} above the band. A manager signs in here
            and gives a reason. Both are recorded on the deal.
          </p>
          <label className="pm-field"><span>Manager email</span>
            <input type="email" autoComplete="off" value={manager.email} onChange={(e) => setManager({ ...manager, email: e.target.value })} required />
          </label>
          <label className="pm-field"><span>Password</span>
            <input type="password" autoComplete="off" value={manager.password} onChange={(e) => setManager({ ...manager, password: e.target.value })} required />
          </label>
          <label className="pm-field"><span>Reason</span>
            <input value={manager.reason} maxLength={500} onChange={(e) => setManager({ ...manager, reason: e.target.value })} required />
          </label>
          {message?.tone === "bad" ? <p className="pm-note pm-note--bad">{message.text}</p> : null}
          <div className="pm-dialog-actions">
            <button type="button" className="pm-btn" onClick={() => managerDialog.current?.close()}>Cancel</button>
            <button type="submit" className="pm-btn pm-btn--go" disabled={pending}>{pending ? "Saving..." : "Approve and save"}</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
