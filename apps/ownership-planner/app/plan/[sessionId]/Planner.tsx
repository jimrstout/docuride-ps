"use client";

// The Ownership Planner.
//
// Ported from the approved All Seasons prototype. The visual system, the
// photography-led layout, the vehicle-aware discovery copy and the neutral
// Include / I'll manage this pair are kept. The prototype's application logic is
// not: several of its behaviours were compliance problems, and each replacement
// is marked below.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CatalogEntry,
  Disposition,
  OfferProduct,
  SessionPayload,
} from "@/lib/types";
import { num } from "@/lib/types";
import { money, planTotals, productPayment } from "@/lib/money";
import { profileFor } from "@/lib/profiles";

const STEPS = [
  "Your Ownership",
  "Care & Protection",
  "Payment Plan",
  "Your Plan",
  "Acknowledgment",
];

const LABELS = [
  "OWNERSHIP PLANNER",
  "CARE & PROTECTION",
  "PAYMENT PLAN",
  "YOUR OWNERSHIP PLAN",
  "WHAT YOU DECIDED",
];

/** A product is presentable only when it has a price and the copy to explain it. */
interface Presentable {
  offer: OfferProduct;
  copy: CatalogEntry;
  price: number;
}

export default function Planner({ initial }: { initial: SessionPayload }) {
  const { session } = initial;
  const [step, setStep] = useState(0);

  // REPLACED: the prototype opened with state.selected = {vsc:true, gap:true},
  // so the Extended Service Plan and GAP began the session already marked
  // Include. Pre-checked F&I products is the practice regulators pursue most
  // directly, and it contradicts the premise that neither choice is the correct
  // one. Nothing starts selected.
  const [decisions, setDecisions] = useState<Record<string, Disposition>>(() => {
    const resumed: Record<string, Disposition> = {};
    for (const s of initial.selections ?? []) {
      resumed[s.provider_product_id] = s.disposition;
    }
    return resumed;
  });

  const [options, setOptions] = useState<Record<string, string[]>>(() => {
    const resumed: Record<string, string[]> = {};
    for (const s of initial.selections ?? []) {
      if (Array.isArray(s.selected_options)) {
        resumed[s.provider_product_id] = s.selected_options as string[];
      }
    }
    return resumed;
  });

  const [answers, setAnswers] = useState<string[]>(
    () => (initial.session.discovery?.use_context as string[]) ?? []
  );
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [ackState, setAckState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [photos, setPhotos] = useState<string[]>(initial.photos ?? []);

  const profile = profileFor(session.vehicle.tecassured_code);
  const presentedAt = useRef(new Date().toISOString());

  // ── What can actually be shown ──────────────────────────────────────────
  const copyByCode = useMemo(() => {
    const m = new Map<string, CatalogEntry>();
    for (const c of initial.catalog ?? []) m.set(c.product_code, c);
    return m;
  }, [initial.catalog]);

  const { presentable, withheld, unmatched } = useMemo(() => {
    const ok: Presentable[] = [];
    const bad: { name: string; why: string }[] = [];
    const missing: { name: string; code: string }[] = [];

    for (const offer of initial.offer?.products ?? []) {
      const copy = copyByCode.get(offer.product_code);
      const price = offer.retail_price;

      // Filtering by genuine eligibility is correct. Filtering for relevance is
      // steering, and is not done anywhere here. The exclusions below are
      // neither: a product with no price or no plain-language copy cannot be
      // presented honestly, which is exactly what the catalog exists to enforce.
      //
      // The order matters. A product with no catalog row at all is not a
      // withheld product, it is one we failed to recognise, and that is the
      // most fundamental of the three -- so it is checked first and reported
      // separately rather than being folded in with the deliberate cases.
      if (!copy) {
        missing.push({ name: offer.product_name, code: offer.product_code });
        continue;
      }
      if (price === null || price === undefined) {
        bad.push({ name: offer.product_name, why: offer.unpriced_reason ?? "No price available" });
        continue;
      }
      if (!copy.is_presentable) {
        bad.push({
          name: copy.display_name || offer.product_name,
          why: "No approved plain-language description on file yet",
        });
        continue;
      }
      ok.push({ offer, copy, price });
    }

    // Discovery reorders. It never removes. The prototype's applicable() filtered
    // the product list by vehicle profile while the interface claimed every
    // applicable option was shown; that is steering, and it is gone.
    ok.sort((a, b) => {
      const score = (p: Presentable) =>
        answers.filter((ans) => (p.copy.relevance_tags ?? []).includes(ans)).length;
      const d = score(b) - score(a);
      return d !== 0 ? d : a.copy.display_order - b.copy.display_order;
    });

    return { presentable: ok, withheld: bad, unmatched: missing };
  }, [initial.offer, copyByCode, answers]);

  // ── Payment basis ───────────────────────────────────────────────────────
  const principal = num(session.financials.amortized_principal);
  const rate = session.financials.rate_used;
  const term = session.financials.term_months;
  const canPrice = principal !== null && rate !== null && term !== null && term > 0;

  const includedPrices = presentable
    .filter((p) => decisions[p.offer.product_code] === "Included")
    .map((p) => p.price + surchargeCost(p, options[p.offer.product_code] ?? []));

  const totals = canPrice
    ? planTotals(principal!, includedPrices, rate!, term!)
    : null;

  // ── Persistence ─────────────────────────────────────────────────────────
  // Saved on every decision, not just at the end. This is what makes the session
  // resumable and what creates the record of what was presented.
  const save = useCallback(
    async (complete = false) => {
      setSaveState("saving");
      try {
        const body = {
          decisions: presentable.map((p) => {
            const disposition = decisions[p.offer.product_code];
            const chosen = options[p.offer.product_code] ?? [];
            const price = p.price + surchargeCost(p, chosen);
            return {
              product_code: p.offer.product_code,
              product_type: p.offer.product_type,
              product_name: p.copy.display_name,
              disposition: disposition ?? "Managed by Customer",
              rate_unique_id: p.offer.rate_unique_id,
              term_months: p.offer.term_months,
              term_miles: p.offer.term_miles,
              deductible: p.offer.deductible,
              dealer_cost: p.offer.dealer_cost,
              retail_price: price,
              customer_price: price,
              selected_options: chosen,
              rate_snapshot: p.offer.raw,
            };
          }),
          discovery: { use_context: answers },
          presented_at: presentedAt.current,
          complete,
        };

        const res = await fetch(`/api/session/${session.id}/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        setSaveState(res.ok ? "saved" : "error");
      } catch {
        setSaveState("error");
      }
    },
    [presentable, decisions, options, answers, session.id]
  );

  // Debounced autosave. Only once the customer has actually decided something --
  // an untouched session should not be recorded as a presentation.
  useEffect(() => {
    if (Object.keys(decisions).length === 0 && answers.length === 0) return;
    const t = setTimeout(() => void save(false), 700);
    return () => clearTimeout(t);
  }, [decisions, options, answers, save]);

  // Photos of the customer's actual machine, looked up server-side by VIN.
  useEffect(() => {
    if (photos.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/session/${session.id}/photos`, { method: "POST" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { photos?: string[] };
        if (!cancelled && Array.isArray(data.photos)) setPhotos(data.photos);
      } catch {
        // An empty vehicle panel is a designed state, so a failed lookup is not
        // worth interrupting the customer for.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // Generated when the customer completes the plan, before contract submit, so
  // a failed submit still leaves a record of what was presented and agreed --
  // and generated even when nothing was included, because that is the session
  // most worth having a record of.
  const finish = useCallback(async () => {
    setAckState("working");
    try {
      await save(true);
      const res = await fetch(`/api/session/${session.id}/acknowledgment`, {
        method: "POST",
      });
      setAckState(res.ok ? "done" : "error");
    } catch {
      setAckState("error");
    }
  }, [save, session.id]);

  const decided = presentable.filter((p) => decisions[p.offer.product_code]).length;
  const allDecided = presentable.length > 0 && decided === presentable.length;

  const vehicleName = [
    session.vehicle.year,
    session.vehicle.make,
    session.vehicle.model,
    session.vehicle.submodel,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <span className="mountains">⌃⌃</span>
          <div>
            <b>ALL SEASONS</b>
            <small>POWERSPORTS &amp; EQUIPMENT</small>
          </div>
        </div>
        <div className="tag">PEOPLE.<br />PLACES.<br />POSSIBILITIES.</div>
        <nav>
          {STEPS.map((n, i) => (
            <div key={n} className={`prog ${i <= step ? "active" : ""}`}>
              <b>{i + 1}</b>
              <span>{n}</span>
            </div>
          ))}
        </nav>
        <div className="experience">
          A BETTER<br />OWNERSHIP<br />EXPERIENCE<i />
        </div>
      </header>

      <main className="planner">
        <aside className="vehicle-panel">
          <div className="overline">YOUR VEHICLE</div>

          {photos.length > 0 ? (
            <div
              className="vehicle-photo"
              style={{ backgroundImage: `url(${photos[0]})` }}
              role="img"
              aria-label={vehicleName}
            />
          ) : (
            // The designed empty state. Never a stock photo of a different
            // machine -- that is worse than no photo.
            <div className="vehicle-plate">
              <div className="yr">{session.vehicle.year ?? ""}</div>
              <div className="mk">
                {session.vehicle.make}
                <br />
                {session.vehicle.model}
              </div>
              {session.vehicle.vin && <div className="vin">VIN {session.vehicle.vin}</div>}
            </div>
          )}

          <h2>{vehicleName || "Your vehicle"}</h2>
          <p>
            {[session.vehicle.condition, session.vehicle.stock_number && `Stock ${session.vehicle.stock_number}`]
              .filter(Boolean)
              .join(" • ")}
          </p>
          <i />

          {/* REPLACED: the prototype offered term, down payment and trade-in as
              segmented controls the buyer could change. By the time a session
              opens the deal is structured and, on a financed deal, a lienholder
              has approved a specific amount at a specific rate over a specific
              term. These are shown, not offered. */}
          <div className="deal-facts">
            {session.financials.finance_type && (
              <div><span>Type</span><b>{session.financials.finance_type}</b></div>
            )}
            {term !== null && (
              <div><span>Term</span><b>{term} months</b></div>
            )}
            {rate !== null && (
              <div><span>{session.financials.rate_label}</span><b>{rate}%</b></div>
            )}
            {session.financials.lienholder_name && (
              <div><span>Lender</span><b>{session.financials.lienholder_name}</b></div>
            )}
            <span className="note">
              These terms come from your finalized deal. If anything needs to change,
              your dealership updates the deal and this plan is refreshed.
            </span>
          </div>
        </aside>

        <section className="content">
          <div className="content-inner">
            <div className="overline section-label">{LABELS[step]}</div>

            {/* ── 0. Discovery ─────────────────────────────────────────── */}
            <div className={`screen ${step === 0 ? "active" : ""}`}>
              <h1>{profile.question}</h1>
              <p className="intro">{profile.intro}</p>
              <div className="visual-options">
                {profile.options.map((o) => {
                  const on = answers.includes(o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      aria-pressed={on}
                      className={`visual-option ${on ? "selected" : ""}`}
                      onClick={() =>
                        setAnswers((a) =>
                          a.includes(o.value) ? a.filter((x) => x !== o.value) : [...a, o.value]
                        )
                      }
                    >
                      <div className="pic" style={{ backgroundImage: `url('${o.image}')` }} />
                      <div className="body">
                        <span className="box" />
                        <div>
                          <b>{o.label}</b>
                          <small>{o.hint}</small>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── 1. Care & Protection ─────────────────────────────────── */}
            <div className={`screen ${step === 1 ? "active" : ""}`}>
              <h1>Protection for the road ahead.</h1>
              <p className="intro">
                Neither answer is the right one. Take what fits how you'll actually
                own it, and leave the rest.
              </p>

              {presentable.length === 0 ? (
                // A session can legitimately open with no offers: trailers,
                // electric bicycles, excavators, zero turns and tractors are not
                // ratable. An empty list under a heading promising options would
                // be worse than saying so.
                <div className="notice">
                  <h2>There are no protection plans for this unit.</h2>
                  <p>
                    Coverage isn&apos;t offered on this type of machine. Nothing is
                    missing from your deal and there&apos;s nothing for you to decide
                    here.
                  </p>
                  <p>Your dealership can still answer any question about owning it.</p>
                </div>
              ) : (
                <>
                  <div className="products">
                    {presentable.map((p) => (
                      <ProductCard
                        key={p.offer.product_code}
                        item={p}
                        chosenOptions={options[p.offer.product_code] ?? []}
                        disposition={decisions[p.offer.product_code]}
                        open={!!open[p.offer.product_code]}
                        rate={rate}
                        term={term}
                        onToggleOpen={() =>
                          setOpen((o) => ({
                            ...o,
                            [p.offer.product_code]: !o[p.offer.product_code],
                          }))
                        }
                        onDecide={(d) =>
                          setDecisions((s) => ({ ...s, [p.offer.product_code]: d }))
                        }
                        onOption={(code, on) =>
                          setOptions((s) => {
                            const cur = s[p.offer.product_code] ?? [];
                            return {
                              ...s,
                              [p.offer.product_code]: on
                                ? [...cur, code]
                                : cur.filter((c) => c !== code),
                            };
                          })
                        }
                      />
                    ))}
                  </div>

                  {/* The prototype claimed every applicable option was shown while
                      filtering the list. This says what actually happens. */}
                  <p className="all-options">
                    Every plan you&apos;re eligible for is listed here. Your earlier
                    answers change the order they appear in, never which ones appear.
                  </p>

                  {withheld.length > 0 && (
                    <p className="all-options">
                      {withheld.length} plan{withheld.length === 1 ? "" : "s"} offered by
                      the provider {withheld.length === 1 ? "is" : "are"} not shown
                      because {withheld.length === 1 ? "it does" : "they do"} not yet have
                      approved pricing and plain-language terms on file. Your dealership
                      can tell you more.
                    </p>
                  )}

                  {/* A different thing entirely, and not a decision anybody
                      made: these were rated but matched nothing in the
                      catalog. Saying so is how it gets noticed at all -- in a
                      self-guided session there is no member of staff watching
                      the screen, and the alternative is a store quietly not
                      offering a plan for a month. */}
                  {unmatched.length > 0 && (
                    <p className="all-options warn">
                      <b>Please check with your dealership before you finish.</b>{" "}
                      {unmatched.length === 1 ? "An option" : `${unmatched.length} options`}{" "}
                      offered for your machine could not be displayed here, so this list
                      may be incomplete. This is a problem on our end, not a decision
                      about what you qualify for.
                    </p>
                  )}
                </>
              )}
            </div>

            {/* ── 2. Payment Plan ──────────────────────────────────────── */}
            <div className={`screen ${step === 2 ? "active" : ""}`}>
              <h1>What it comes to.</h1>
              <p className="intro">
                Your deal is already structured. This shows what your choices add to it.
              </p>

              <div className="finance-box">
                <div className="terms-readonly">
                  <div>
                    <span>AMOUNT FINANCED</span>
                    <b>{principal !== null ? money(principal) : "—"}</b>
                  </div>
                  <div>
                    <span>TERM</span>
                    <b>{term !== null ? `${term} months` : "—"}</b>
                  </div>
                  <div>
                    {/* Label honestly: whichever value is used names itself. */}
                    <span>{(session.financials.rate_label ?? "RATE").toUpperCase()}</span>
                    <b>{rate !== null ? `${rate}%` : "—"}</b>
                  </div>
                </div>

                {totals ? (
                  <>
                    <div className="estimate">
                      <div>
                        <small>MONTHLY PAYMENT</small>
                        <strong>{money(totals.totalPayment)}</strong>
                      </div>
                      <div className="breakdown">
                        <div><span>Vehicle</span><b>{money(totals.vehiclePayment)}</b></div>
                        <div><span>Your plan</span><b>{money(totals.planPayment)}</b></div>
                        <div className="rule"><span>Total</span><b>{money(totals.totalPayment)}</b></div>
                      </div>
                    </div>
                    <p className="fine">
                      Calculated from your financed amount of {money(principal!)} over{" "}
                      {term} months at {rate}%
                      {session.financials.rate_source === "apr"
                        ? " annual percentage rate"
                        : " interest"}
                      . The total is figured on the combined amount, not by adding up
                      each plan separately, so it matches your contract.
                    </p>
                  </>
                ) : (
                  <p className="fine">
                    We can&apos;t show a payment for this deal yet — the financing terms
                    haven&apos;t been finalized. Your dealership can walk you through the
                    numbers.
                  </p>
                )}
              </div>
            </div>

            {/* ── 3. Your Plan ─────────────────────────────────────────── */}
            <div className={`screen ${step === 3 ? "active" : ""}`}>
              <h1>Here&apos;s your plan.</h1>
              <p className="intro">
                Everything you were shown, and what you decided about each. Change
                anything you like.
              </p>

              <div className="summary-card">
                <div className="summary-title">WHAT YOU WERE SHOWN</div>
                {presentable.length === 0 && (
                  <div className="summary-row"><span>No plans are offered for this unit.</span></div>
                )}
                {presentable.map((p) => {
                  const d = decisions[p.offer.product_code];
                  const price = p.price + surchargeCost(p, options[p.offer.product_code] ?? []);
                  return (
                    <div className="summary-row" key={p.offer.product_code}>
                      <span className="what">
                        <b>{p.copy.display_name}</b>
                        <span>
                          {p.copy.coverage_duration}
                          {d === "Included" ? ` • ${money(price)}` : ""}
                        </span>
                      </span>
                      {/* REPLACED: the prototype's buttons said "I'll manage this"
                          and the summary then printed "Not Selected" -- framing the
                          customer's decision as a failure to act on the one screen
                          they take home. The language is the same in both places. */}
                      <span className={`decision ${d === "Included" ? "" : "managed"}`}>
                        {d ?? "Not yet decided"}
                      </span>
                    </div>
                  );
                })}
              </div>

              {totals && (
                <div className="summary-card">
                  <div className="summary-title">PAYMENT</div>
                  <div className="summary-row"><span>Vehicle</span><b>{money(totals.vehiclePayment)}</b></div>
                  <div className="summary-row"><span>Your plan</span><b>{money(totals.planPayment)}</b></div>
                  <div className="summary-row"><span>Total monthly payment</span><b>{money(totals.totalPayment)}</b></div>
                  <div className="summary-row">
                    <span>{session.financials.rate_label} and term</span>
                    <b>{rate}% • {term} months</b>
                  </div>
                </div>
              )}
            </div>

            {/* ── 4. Acknowledgment ────────────────────────────────────── */}
            <div className={`screen ${step === 4 ? "active" : ""}`}>
              <div className="finish">
                <div className="finish-mark">AS</div>
                <h1>You bought something worth owning.</h1>
                <p>Let&apos;s help you own it well.</p>
              </div>

              {/* REPLACED: the prototype ended in an alert(). This is the record of
                  what was presented and what was decided -- the document that makes
                  a self-guided session defensible. It is generated even when nothing
                  was included, because that is the session most worth a record. */}
              <div className="ack">
                <h2>What you were shown, and what you decided</h2>
                <p>
                  Your plan has been saved and prepared for signing. It lists every
                  plan you were shown, what you decided about each, and the payment
                  those decisions produce.
                </p>
                <p>
                  Protection plans are optional. Declining any of them does not affect
                  your credit approval or the terms of your sale. Pricing was presented
                  by this system rather than negotiated.
                </p>
                <p className="meta">
                  {ackState === "working" && "Preparing your record…"}
                  {ackState === "done" && "Saved and ready for signing."}
                  {ackState === "error" &&
                    "We saved your plan, but couldn't prepare the signing copy. Your dealership can finish this for you."}
                  <br />
                  Session {session.id}
                  <br />
                  {session.mode_label} • Prepared {new Date(presentedAt.current).toLocaleString("en-US")}
                </p>
              </div>
            </div>
          </div>

          <footer>
            <button
              className="back"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              style={{ visibility: step === 0 ? "hidden" : "visible" }}
            >
              ← BACK
            </button>

            <div className="status">
              {saveState === "saving" && "Saving…"}
              {saveState === "saved" && "Saved — you can come back to this later"}
              {saveState === "error" && "We couldn't save that. We'll keep trying."}
              {saveState === "idle" && step === 1 && presentable.length > 0 &&
                `${decided} of ${presentable.length} decided`}
            </div>

            <button
              className="dark"
              disabled={step === 1 && presentable.length > 0 && !allDecided}
              onClick={() => {
                if (step === 3) void finish();
                setStep((s) => Math.min(STEPS.length - 1, s + 1));
              }}
            >
              {step === 3 ? "FINISH & SAVE PLAN" : step === 4 ? "DONE" : "CONTINUE"}
              <span>→</span>
            </button>
          </footer>
        </section>
      </main>

      <div className="brand-footer">
        <div className="logo">
          <span className="mountains">⌃⌃</span>
          <div><b>ALL SEASONS</b><small>POWERSPORTS &amp; EQUIPMENT</small></div>
        </div>
        <div><b>LOCAL EXPERTISE</b><span>People who ride, work and live here.</span></div>
        <div><b>LONG-TERM SUPPORT</b><span>Service, parts and expertise.</span></div>
        <div><b>STRONGER COMMUNITIES</b><span>Riders, workers and neighbors just like you.</span></div>
      </div>
    </div>
  );
}

/** Surcharges the customer added (lift kit, oversized tires, mud use, turbo). */
function surchargeCost(p: Presentable, chosen: string[]): number {
  return p.offer.surcharge_options
    .filter((o) => chosen.includes(o.code))
    .reduce((a, o) => a + o.cost_delta, 0);
}

function ProductCard({
  item,
  disposition,
  chosenOptions,
  open,
  rate,
  term,
  onToggleOpen,
  onDecide,
  onOption,
}: {
  item: Presentable;
  disposition: Disposition | undefined;
  chosenOptions: string[];
  open: boolean;
  rate: number | null;
  term: number | null;
  onToggleOpen: () => void;
  onDecide: (d: Disposition) => void;
  onOption: (code: string, on: boolean) => void;
}) {
  const { copy, offer } = item;
  const price = item.price + surchargeCost(item, chosenOptions);
  const perMonth = rate !== null && term !== null ? productPayment(price, rate, term) : null;

  return (
    <div className="product">
      <div className="product-head">
        <div>
          <div className="goal">{copy.goal.toUpperCase()}</div>
          {/* REMOVED: the prototype badged whichever product happened to sit
              first in the filtered array as RECOMMENDED. That is not a
              recommendation, it is an array index wearing a badge. */}
          <h3>{copy.display_name}</h3>
          {/* REPLACED: taglines. Tire & Wheel read, in full, "Because the road or
              trail isn't always smooth" -- no coverage, term, deductible,
              exclusions, claim process or transferability anywhere. */}
          <p className="accomplishes">{copy.what_it_accomplishes}</p>
        </div>

        <div className="price-block">
          <span className="total">{money(price)}</span>
          {perMonth !== null && (
            // Never a bare monthly figure. The total and the duration sit with it.
            <span className="per-month">or about {money(perMonth)}/mo</span>
          )}
          <span className="duration">{copy.coverage_duration}</span>
        </div>
      </div>

      {offer.surcharge_options.length > 0 && (
        <div className="surcharges">
          <b>Does any of this apply to your machine?</b>
          {offer.surcharge_options.map((o) => (
            <label key={o.code}>
              <input
                type="checkbox"
                checked={chosenOptions.includes(o.code)}
                onChange={(e) => onOption(o.code, e.target.checked)}
              />{" "}
              {o.label}
              {o.cost_delta > 0 ? ` (+${money(o.cost_delta)})` : ""}
            </label>
          ))}
        </div>
      )}

      <button className="disclose" onClick={onToggleOpen} aria-expanded={open}>
        {open ? "Hide the details" : "What's covered, what isn't"}
      </button>

      {open && (
        <div className="detail">
          <dl>
            <dt>What it covers</dt>
            <dd>{copy.what_it_covers}</dd>

            <dt>How long</dt>
            <dd>{copy.coverage_duration}</dd>

            <dt>What it doesn&apos;t cover</dt>
            <dd>{copy.what_it_excludes}</dd>

            {copy.deductible_note && (<><dt>Deductible</dt><dd>{copy.deductible_note}</dd></>)}

            <dt>How to use it</dt>
            <dd>{copy.how_to_use}</dd>

            <dt>If you sell it</dt>
            <dd>
              {copy.transferable ? "Transferable to the next owner." : "Not transferable."}
              {copy.transfer_note ? ` ${copy.transfer_note}` : ""}
            </dd>

            {copy.future_value_note && (<><dt>Down the road</dt><dd>{copy.future_value_note}</dd></>)}

            {offer.deductible !== null && (
              <><dt>Your deductible</dt><dd>{money(offer.deductible)}</dd></>
            )}

            <dt>Full terms</dt>
            <dd>
              <a href={copy.full_terms_url ?? "#"} target="_blank" rel="noreferrer noopener">
                Read the complete contract
              </a>
            </dd>
          </dl>
        </div>
      )}

      {/* The neutral pair, kept from the prototype. Neither is styled as the
          default and neither is pre-selected. */}
      <div className="choice-actions">
        <button
          className={disposition === "Included" ? "selected" : ""}
          aria-pressed={disposition === "Included"}
          onClick={() => onDecide("Included")}
        >
          <span className="check" />
          Include
        </button>
        <button
          className={disposition === "Managed by Customer" ? "selected" : ""}
          aria-pressed={disposition === "Managed by Customer"}
          onClick={() => onDecide("Managed by Customer")}
        >
          <span className="check" />
          I&apos;ll manage this
        </button>
      </div>
    </div>
  );
}
