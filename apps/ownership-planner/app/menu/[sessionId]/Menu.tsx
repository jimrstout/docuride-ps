"use client";

// The conventional menu: package columns side by side, every rated product in
// every column, checked or not (lib/menu-model.ts). Each column shows its
// total, and on a financed deal its monthly payment, worked out the way the
// Ownership Planner works it out (planTotals, lib/money.ts): on the combined
// amount financed, with the finance company's maximum, never by adding up
// rounded per-product payments. A cash deal shows the total only.
//
// Staff can check or uncheck any product in any column, and change its level,
// term, deductible and options with the planner's own controls, in a dialog.
// A change affects that column only. "Select this package" saves the column
// the way the planner saves a plan, then asks for the same acknowledgment.
// "Decline everything" saves every product as Managed by Customer and asks
// for the same acknowledgment.
//
// The whole screen fits the window, with no scrolling: the rows share the
// height between the header and the column footers. On a phone one column is
// shown at a time, chosen from tabs that carry every column's total.

import { useMemo, useRef, useState } from "react";
import type { OfferRate, SessionPayload, SurchargeOption } from "@/lib/types";
import { num } from "@/lib/types";
import { money, planTotals, toCents } from "@/lib/money";
import { apiPath } from "@/lib/paths";
import TierChooser from "@/components/TierChooser";
import RateChooser from "@/components/RateChooser";
import ProductConfigurator from "@/components/ProductConfigurator";
import {
  PURCHASED,
  UNAVAILABLE,
  buildRows,
  cellAvailable,
  cellCaption,
  cellLocked,
  cellPrice,
  columnPrices,
  declinedCells,
  initialCells,
  rateOf,
  saveDecisions,
  tierOf,
  type Cell,
  type MenuCatalogEntry,
  type MenuColumnSpec,
  type MenuOfferFamily,
  type MenuRow,
} from "@/lib/menu-model";
import "./menu.css";

const DEFAULT_COLUMNS: MenuColumnSpec[] = [
  { name: "Platinum", preset_categories: ["Mechanical Protection", "Maintenance", "Tire and Wheel", "Theft", "Battery", "Appearance"], starting_level: "Highest" },
  { name: "Gold", preset_categories: ["Mechanical Protection", "Tire and Wheel", "Theft", "Battery"], starting_level: "Middle" },
  { name: "Silver", preset_categories: ["Mechanical Protection", "Tire and Wheel"], starting_level: "Lowest" },
  { name: "Basic", preset_categories: ["Mechanical Protection"], starting_level: "Lowest" },
];

type Phase = "menu" | "saving" | "done" | "error";

/** "36 months", "36 months, $100 deductible", or nothing. */
function termLine(rate: OfferRate | undefined): string {
  if (!rate) return "";
  const parts = [
    rate.term_months ? `${rate.term_months} months` : null,
    rate.term_miles ? `${rate.term_miles.toLocaleString("en-US")} miles` : null,
    rate.deductible !== null && rate.deductible !== undefined ? `${money(rate.deductible)} deductible` : null,
  ].filter(Boolean);
  return parts.join(", ");
}

export default function Menu({ initial }: { initial: SessionPayload }) {
  const { session } = initial;
  const presentedAt = useRef(new Date().toISOString());

  const columns: MenuColumnSpec[] = initial.menu_columns && initial.menu_columns.length >= 2
    ? (initial.menu_columns as MenuColumnSpec[])
    : DEFAULT_COLUMNS;

  const rows: MenuRow[] = useMemo(
    () =>
      buildRows(
        (initial.offer?.families ?? []) as unknown as MenuOfferFamily[],
        (initial.catalog ?? []) as unknown as MenuCatalogEntry[],
        initial.purchased ?? [],
        (initial.selections ?? []) as never
      ),
    [initial]
  );

  const [cells, setCells] = useState<Cell[][]>(() => initialCells(rows, columns));
  const [shown, setShown] = useState(0);
  const [editing, setEditing] = useState<{ col: number; row: number } | null>(null);
  const [phase, setPhase] = useState<Phase>("menu");
  const [outcome, setOutcome] = useState<{ name: string; lines: { name: string; term: string; price: number }[]; total: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const once = useRef(false);

  // ── The payment, as the planner works it out ───────────────────────────
  const principal = num(session.financials.amortized_principal);
  const rate = session.financials.rate_used;
  const term = session.financials.term_months;
  const hasPayment = session.financials.has_payment === true && principal !== null && rate !== null && term !== null;
  const isCash = session.financials.payment_basis === "cash";
  const cap = isCash ? null : num(session.financials.max_amount_financed);

  const figures = cells.map((col) => {
    const prices = columnPrices(rows, col);
    const total = toCents(prices.reduce((a, p) => a + p, 0));
    const totals = hasPayment ? planTotals(principal!, prices, rate!, term!, cap) : null;
    return { total, totals };
  });

  const vehicleName = [session.vehicle.year, session.vehicle.make, session.vehicle.model, session.vehicle.submodel]
    .filter(Boolean)
    .join(" ");
  const basisLine = isCash
    ? "Paid in full, so there is no monthly payment."
    : hasPayment
      ? `Financed over ${term} months at ${rate}%.`
      : "The financing terms are not finalized, so totals only.";

  const setCell = (col: number, row: number, next: Partial<Cell>) =>
    setCells((all) => all.map((c, ci) => (ci !== col ? c : c.map((cell, ri) => (ri !== row ? cell : { ...cell, ...next })))));

  const openCell = (col: number, row: number) => {
    setEditing({ col, row });
    dialog.current?.showModal();
  };

  // ── Recording the choice, the planner's way ────────────────────────────
  const record = async (chosen: Cell[], name: string) => {
    const declined = name === "";
    if (once.current) return;
    once.current = true;
    setPhase("saving");
    try {
      const res = await fetch(apiPath(`/api/session/${session.id}/save`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: saveDecisions(rows, chosen, presentedAt.current),
          presented_at: presentedAt.current,
          complete: true,
          // The menu's own record: its path, staff-presented, and what was chosen.
          presentation_path: "Conventional Menu",
          mode: "Staff-Presented",
          menu_event: declined ? { kind: "declined" } : { kind: "selected", package: name },
        }),
      });
      if (!res.ok) throw new Error("save");
      await fetch(apiPath(`/api/session/${session.id}/acknowledgment`), { method: "POST" });
      const lines = rows
        .map((r, i) => ({ r, c: chosen[i] }))
        .filter(({ r, c }) => c.checked && cellPrice(r, c) !== null)
        .map(({ r, c }) => ({
          name: tierOf(r, c)?.name ?? r.label,
          term: termLine(rateOf(r, c) as unknown as OfferRate),
          price: cellPrice(r, c)!,
        }));
      setOutcome({ name, lines, total: toCents(lines.reduce((a, l) => a + l.price, 0)) });
      setPhase("done");
    } catch {
      once.current = false;
      setPhase("error");
    }
  };

  // ── Nothing to show ────────────────────────────────────────────────────
  if (rows.length === 0) {
    return (
      <div className="mn mn--note">
        <div className="mn-note">
          <p className="mn-eyebrow">Protection menu</p>
          <h1>We&apos;re still getting your options ready.</h1>
          <p>Your dealership will help you with this step. Nothing you have decided is lost.</p>
        </div>
      </div>
    );
  }

  if (phase === "done" && outcome) {
    return (
      <div className="mn mn--note">
        <div className="mn-note">
          <p className="mn-eyebrow">Protection menu</p>
          <h1>{outcome.lines.length > 0 ? `${outcome.name} selected.` : "Everything declined."}</h1>
          {outcome.lines.length > 0 ? (
            <ul className="mn-done">
              {outcome.lines.map((l) => (
                <li key={l.name}>
                  <span>{l.name}{l.term ? <small>{l.term}</small> : null}</span>
                  <b>{money(l.price)}</b>
                </li>
              ))}
              <li className="mn-done-total"><span>Total</span><b>{money(outcome.total)}</b></li>
            </ul>
          ) : (
            <p>Every product was declined. Protection plans are optional, and declining them does not affect the terms of your sale.</p>
          )}
          <p>Your choices are saved and your acknowledgment is ready for signing. Your dealership takes it from here.</p>
        </div>
      </div>
    );
  }

  const editRow = editing ? rows[editing.row] : null;
  const editCell = editing ? cells[editing.col][editing.row] : null;
  const editTier = editRow && editCell ? tierOf(editRow, editCell) : undefined;
  const editRate = editRow && editCell ? (rateOf(editRow, editCell) as unknown as OfferRate | undefined) : undefined;

  return (
    <div className="mn" style={{ ["--mn-rows" as string]: rows.length, ["--mn-cols" as string]: columns.length }}>
      <header className="mn-head">
        <div>
          <p className="mn-eyebrow">Protection menu</p>
          <h1>{vehicleName || "Your vehicle"}</h1>
          <p className="mn-basis">{basisLine}</p>
        </div>
        <button type="button" className="mn-btn mn-btn--quiet" disabled={phase === "saving"} onClick={() => void record(declinedCells(rows, cells[0]), "")}>
          Decline everything
        </button>
      </header>

      {/* Phone: one column at a time, every column's total on its tab. */}
      <nav className="mn-tabs" aria-label="Packages">
        {columns.map((c, ci) => (
          <button key={c.name} type="button" className={ci === shown ? "is-here" : undefined} aria-pressed={ci === shown} onClick={() => setShown(ci)}>
            {c.name}
          </button>
        ))}
      </nav>

      <div className="mn-grid" role="table" aria-label="Packages">
        <div className="mn-row mn-row--head" role="row">
          <span className="mn-label" role="columnheader">Product</span>
          {columns.map((c, ci) => (
            <span key={c.name} className={`mn-colhead ${ci === shown ? "is-shown" : ""}`} role="columnheader">{c.name}</span>
          ))}
        </div>

        {rows.map((row, ri) => (
          <div key={row.family_code} className="mn-row" role="row">
            <span className="mn-label" role="rowheader" title={row.label}>{row.label}</span>
            {columns.map((c, ci) => {
              const cell = cells[ci][ri];
              const available = cellAvailable(row);
              const locked = cellLocked(row);
              const price = cellPrice(row, cell);
              const t = tierOf(row, cell);
              return (
                <div key={c.name} className={`mn-cell ${ci === shown ? "is-shown" : ""} ${cell.checked ? "is-on" : ""}`} role="cell">
                  {available ? (
                    <>
                      <input
                        type="checkbox"
                        className="mn-box"
                        checked={cell.checked}
                        disabled={locked || phase === "saving"}
                        onChange={(e) => setCell(ci, ri, { checked: e.target.checked })}
                        aria-label={`${t?.name ?? row.label} in ${c.name}`}
                      />
                      {locked ? (
                        <span className="mn-cap mn-tag" title={t?.name}>{PURCHASED}</span>
                      ) : (
                        <button
                          type="button"
                          className="mn-cap mn-link"
                          title={`Change ${t?.name ?? row.label}`}
                          disabled={phase === "saving"}
                          onClick={() => openCell(ci, ri)}
                        >
                          <span className="mn-phone-name">{row.label}</span>
                          {cellCaption(row, cell) || "Change"}
                        </button>
                      )}
                      {locked ? (
                        <span className="mn-cell-price" title={`${t?.name ?? row.label}: ${PURCHASED}`}>{price === null ? UNAVAILABLE : money(price)}</span>
                      ) : (
                        // The price opens the same dialog: on narrower screens it is the only way in.
                        <button
                          type="button"
                          className="mn-cell-price"
                          title={`${t?.name ?? row.label}${cellCaption(row, cell) ? `, ${cellCaption(row, cell)}` : ""}`}
                          aria-label={`Change ${t?.name ?? row.label} in ${c.name}, now ${price === null ? UNAVAILABLE : money(price)}`}
                          disabled={phase === "saving"}
                          onClick={() => openCell(ci, ri)}
                        >
                          {price === null ? UNAVAILABLE : money(price)}
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="mn-cell-off">{UNAVAILABLE}<span className="mn-phone-name"> {row.label}</span></span>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        <div className="mn-row mn-row--foot" role="row">
          <span className="mn-label" role="rowheader">{hasPayment ? "Totals" : "Total"}</span>
          {columns.map((c, ci) => {
            const f = figures[ci];
            return (
              <div key={c.name} className={`mn-foot ${ci === shown ? "is-shown" : ""}`} role="cell">
                <b className="mn-total">{money(f.total)}</b>
                {f.totals ? (
                  <span className="mn-month">
                    {money(f.totals.totalPayment)} a month
                    <small>{money(f.totals.planPayment)} for protection</small>
                  </span>
                ) : null}
                {f.totals && f.totals.additionalDown > 0 ? (
                  <small className="mn-down">Adds {money(f.totals.additionalDown)} to your money down.</small>
                ) : null}
                <button
                  type="button"
                  className="mn-btn mn-btn--go"
                  disabled={phase === "saving"}
                  onClick={() => void record(cells[ci], c.name)}
                >
                  {phase === "saving" ? "One moment..." : "Select this package"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {phase === "error" ? (
        <p className="mn-error" role="alert">We couldn&apos;t save that. Nothing was changed. Try again, or ask your dealership for help.</p>
      ) : null}

      <dialog ref={dialog} className="mn-dialog" onClose={() => setEditing(null)} aria-label="Change this product">
        {editing && editRow && editCell && editTier ? (
          <div className="mn-dialog-body">
            <h2>{editRow.label} in {columns[editing.col].name}</h2>
            <TierChooser
              tiers={editRow.tiers.filter((t) => t.available).map((t) => ({ product_code: t.product_code, label: t.name, fromPrice: t.fromPrice }))}
              chosen={editTier.product_code}
              onChoose={(code) => {
                const next = editRow.tiers.find((t) => t.product_code === code);
                setCell(editing.col, editing.row, { tier: code, rate: next?.rates[0]?.rate_unique_id ?? null, options: [] });
              }}
            />
            <RateChooser
              rates={editTier.rates as unknown as OfferRate[]}
              chosen={editRate}
              onChoose={(id) => setCell(editing.col, editing.row, { rate: id })}
            />
            <ProductConfigurator
              productCode={editTier.product_code}
              productName={editTier.name}
              options={(editRate?.options ?? []) as SurchargeOption[]}
              chosen={editCell.options}
              onToggle={(code, on) =>
                setCell(editing.col, editing.row, {
                  options: on ? [...editCell.options, code] : editCell.options.filter((o) => o !== code),
                })
              }
            />
            <p className="mn-dialog-price">
              {editTier.name}: <b>{(() => { const p = cellPrice(editRow, editCell); return p === null ? UNAVAILABLE : money(p); })()}</b>
            </p>
            <div className="mn-dialog-actions">
              <button type="button" className="mn-btn mn-btn--go" onClick={() => dialog.current?.close()}>Done</button>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
