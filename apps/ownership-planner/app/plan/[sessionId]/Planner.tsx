"use client";

// The DocuRide PS ownership planner.
//
// The customer has already chosen the machine. Nothing here re-sells it. The
// job of these screens is to help them decide how they want to OWN it, and the
// shape of the flow follows from that:
//
//   choose the machine  →  plan the ownership  →  enjoy the ownership
//
// Presentation lives in components/. This file holds the state, the arithmetic
// and the rules that were decided for compliance reasons and must not drift:
//
//   Nothing starts selected. The prototype opened with the service contract
//   and GAP already marked Include, which is the practice regulators pursue
//   most directly and contradicts the premise that neither choice is correct.
//
//   Discovery reorders. It never removes. A product the customer is eligible
//   for is presented whatever they answered.
//
//   Every presented product is recorded, including the ones the customer is
//   managing themselves. A record of a presentation that lists only what was
//   bought is not a record of the presentation.
//
//   Monthly figures appear only where a payment honestly exists, and the total
//   is computed from the combined financed amount rather than by summing
//   rounded per-product payments.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CatalogEntry,
  Disposition,
  OfferProduct,
  SessionPayload,
} from "@/lib/types";
import { num } from "@/lib/types";
import { money, planTotals, productPayment, toCents } from "@/lib/money";
import { profileFor, relevanceScore } from "@/lib/profiles";
import { apiPath } from "@/lib/paths";

import AppShell from "@/components/AppShell";
import ProgressStepper from "@/components/ProgressStepper";
import VehicleContext from "@/components/VehicleContext";
import OwnershipQuestion from "@/components/OwnershipQuestion";
import ProductRow, { type Presentable } from "@/components/ProductRow";
import ActionFooter, { type SaveState } from "@/components/ActionFooter";
import PlanSummary, { type PlanLine } from "@/components/PlanSummary";
import CompletionState from "@/components/CompletionState";
import {
  DealTerms,
  PaymentBreakdown,
  PlanCostOnly,
} from "@/components/PaymentSummary";

const STEPS = [
  { n: 1, label: "Your Ownership" },
  { n: 2, label: "Care & Protection" },
  { n: 3, label: "Payment Plan" },
  { n: 4, label: "Your Plan" },
  { n: 5, label: "Acknowledgment" },
];

const EYEBROWS = [
  "Ownership planner",
  "Care & protection",
  "Payment plan",
  "Your ownership plan",
  "What you decided",
];

export default function Planner({ initial }: { initial: SessionPayload }) {
  const { session } = initial;
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);

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

  // Discovery answers, keyed by question. `use_context` is the key the session
  // already stores and every earlier session carries, so it keeps its name.
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => {
    const d = initial.session.discovery ?? {};
    return {
      use_context: (d.use_context as string[]) ?? [],
      priorities: (d.priorities as string[]) ?? [],
    };
  });

  // The opening screen frames what follows. It sits inside step 1 rather than
  // being a step of its own: "Your Ownership" is what it is about, and
  // numbering it separately would tell the buyer the process is longer than it
  // is for a screen that asks them nothing. A resumed session skips it.
  const [intro, setIntro] = useState(
    () =>
      (initial.selections?.length ?? 0) === 0 &&
      ((initial.session.discovery?.use_context as string[]) ?? []).length === 0
  );

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [ackState, setAckState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [photos, setPhotos] = useState<string[]>(initial.photos ?? []);

  const profile = profileFor(session.vehicle.tecassured_code);
  const presentedAt = useRef(new Date().toISOString());

  const allAnswers = useMemo(
    () => Object.values(answers).flat(),
    [answers]
  );

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
      // Order matters. A product with no catalog row at all is not a withheld
      // product, it is one we failed to recognise, so it is checked first and
      // reported separately rather than folded in with the deliberate cases.
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

    // Discovery reorders. It never removes.
    ok.sort((a, b) => {
      const d =
        relevanceScore(b.copy.relevance_tags, b.copy.goal, allAnswers) -
        relevanceScore(a.copy.relevance_tags, a.copy.goal, allAnswers);
      return d !== 0 ? d : a.copy.display_order - b.copy.display_order;
    });

    return { presentable: ok, withheld: bad, unmatched: missing };
  }, [initial.offer, copyByCode, allAnswers]);

  // Grouped under the goal each product serves, in the order relevance put
  // them. One objective at a time reads as a plan; one long list reads as a
  // menu, which is the thing this is not.
  const groups = useMemo(() => {
    const out: { goal: string; id: string; items: Presentable[] }[] = [];
    for (const p of presentable) {
      const goal = p.copy.goal || "Your options";
      let g = out.find((x) => x.goal.toLowerCase() === goal.toLowerCase());
      if (!g) {
        g = { goal, id: `goal-${out.length + 1}`, items: [] };
        out.push(g);
      }
      g.items.push(p);
    }
    return out;
  }, [presentable]);

  // ── Payment basis ───────────────────────────────────────────────────────
  //
  // Resolved server-side, because whether this deal has a payment at all is not
  // something the browser should be deciding. A cash deal -- no lienholder --
  // has none, and every monthly figure below is gated on that rather than on
  // whether the financing columns happen to hold usable numbers.
  const principal = num(session.financials.amortized_principal);
  const rate = session.financials.rate_used;
  const term = session.financials.term_months;
  const hasPayment = session.financials.has_payment === true;
  const isCash = session.financials.payment_basis === "cash";

  const priceOf = useCallback(
    (p: Presentable) => p.price + surchargeCost(p, options[p.offer.product_code] ?? []),
    [options]
  );

  const includedPrices = presentable
    .filter((p) => decisions[p.offer.product_code] === "Included")
    .map(priceOf);

  /** What the plan costs, on every path. A cash deal has this and nothing else. */
  const planTotal = toCents(includedPrices.reduce((a, p) => a + p, 0));

  const totals = hasPayment ? planTotals(principal!, includedPrices, rate!, term!) : null;

  // ── Persistence ─────────────────────────────────────────────────────────
  // Saved on every decision, not just at the end. This is what makes the
  // session resumable and what creates the record of what was presented.
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
          discovery: {
            use_context: answers.use_context ?? [],
            priorities: answers.priorities ?? [],
          },
          presented_at: presentedAt.current,
          complete,
        };

        const res = await fetch(apiPath(`/api/session/${session.id}/save`), {
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
    if (Object.keys(decisions).length === 0 && allAnswers.length === 0) return;
    const t = setTimeout(() => void save(false), 700);
    return () => clearTimeout(t);
  }, [decisions, options, answers, allAnswers.length, save]);

  // Photos of the customer's actual machine, looked up server-side by VIN.
  useEffect(() => {
    if (photos.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(apiPath(`/api/session/${session.id}/photos`), { method: "POST" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { photos?: string[] };
        if (!cancelled && Array.isArray(data.photos)) setPhotos(data.photos);
      } catch {
        // A vehicle panel with no photograph is a designed state, so a failed
        // lookup is not worth interrupting the customer for.
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
      const res = await fetch(apiPath(`/api/session/${session.id}/acknowledgment`), {
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

  const goTo = useCallback((next: number) => {
    setStep(next);
    setFurthest((f) => Math.max(f, next));
    setIntro(false);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const planLines: PlanLine[] = presentable.map((p) => ({
    code: p.offer.product_code,
    name: p.copy.display_name,
    duration: p.copy.coverage_duration,
    price: priceOf(p),
    disposition: decisions[p.offer.product_code],
  }));

  // ── Footer wiring ───────────────────────────────────────────────────────
  const onBack = () => {
    if (step === 0) setIntro(true);
    else goTo(step - 1);
  };
  const onNext = () => {
    if (step === 0 && intro) {
      setIntro(false);
      return;
    }
    if (step === 3) void finish();
    if (step < STEPS.length - 1) goTo(step + 1);
  };
  const nextLabel =
    step === 0 && intro ? "Begin" : step === 3 ? "Finish & save plan" : "Continue";

  const status =
    saveState === "saving" ? "Saving…"
    : saveState === "error" ? "We couldn't save that. We'll keep trying."
    : saveState === "saved" ? "Saved — you can come back to this later"
    : step === 1 && presentable.length > 0 ? `${decided} of ${presentable.length} decided`
    : null;

  const rail = (
    <VehicleContext
      session={session}
      profile={profile}
      photo={photos[0] ?? null}
      vehicleName={vehicleName}
    >
      {step === 1 && groups.length > 1 && (
        <nav className="railnav" aria-label="Sections on this screen">
          <p className="eyebrow">On this screen</p>
          <ul>
            {groups.map((g) => (
              <li key={g.id}><a href={`#${g.id}`}>{g.goal}</a></li>
            ))}
          </ul>
        </nav>
      )}
    </VehicleContext>
  );

  return (
    <AppShell
      stepper={
        <ProgressStepper steps={STEPS} current={step} furthest={furthest} onGo={goTo} />
      }
      rail={rail}
      footer={
        <ActionFooter
          onBack={onBack}
          showBack={!(step === 0 && intro)}
          onNext={onNext}
          nextLabel={nextLabel}
          showNext={step < STEPS.length - 1}
          nextDisabled={step === 1 && presentable.length > 0 && !allDecided}
          status={status}
        />
      }
    >
      <p className="eyebrow eyebrow--rule">{EYEBROWS[step]}</p>

      {/* ── 1a. Opening ──────────────────────────────────────────────────
          Sets the frame before anything is asked. No warnings, and nothing
          about the machine failing: the premise is that they bought something
          worth owning. */}
      {step === 0 && intro && (
        <section className="screen">
          <p className="kicker">{vehicleName || "Your vehicle"}</p>
          <h1 className="display">Your vehicle. Your ownership. Your plan.</h1>
          <p className="lede">
            You&apos;ve chosen the vehicle that&apos;s right for you. Now let&apos;s
            shape an ownership plan around how you want to own it.
          </p>
          <p className="body">
            Owning anything valuable comes with ongoing costs. Some are
            predictable, some aren&apos;t. The options that follow are tools for
            deciding which of those costs you&apos;d rather plan for now, spread
            into smaller amounts, or handle yourself later.
          </p>

          <ul className="goals">
            <li>
              <b>Keep ownership manageable.</b>
              <span>Structure payments and costs to fit your budget.</span>
            </li>
            <li>
              <b>Keep ownership enjoyable.</b>
              <span>Smooth out the peaks, so one expense doesn&apos;t interrupt a ride.</span>
            </li>
            <li>
              <b>Keep it valuable.</b>
              <span>Care for it now to preserve its condition and value.</span>
            </li>
          </ul>

          <p className="body body--close">
            Nothing is preselected, and nothing here is expected of you. Any of
            it can be something you take care of yourself instead — that is a
            real choice, not a lesser one. It takes a few minutes.
          </p>
        </section>
      )}

      {/* ── 1b. Your Ownership ───────────────────────────────────────────── */}
      {step === 0 && !intro && (
        <section className="screen">
          <h1 className="display display--sm">Your plan starts with you.</h1>
          <p className="lede">
            Two questions, then we&apos;ll show you the options. All available
            options are presented either way — your answers only change what
            comes first.
          </p>

          {profile.questions.map((q) => (
            <OwnershipQuestion
              key={q.id}
              question={q}
              chosen={answers[q.id] ?? []}
              onToggle={(value) =>
                setAnswers((a) => {
                  const cur = a[q.id] ?? [];
                  return {
                    ...a,
                    [q.id]: cur.includes(value)
                      ? cur.filter((x) => x !== value)
                      : [...cur, value],
                  };
                })
              }
            />
          ))}
        </section>
      )}

      {/* ── 2. Care & Protection ─────────────────────────────────────────── */}
      {step === 1 && (
        <section className="screen">
          <h1 className="display display--sm">Confidence for what&apos;s ahead.</h1>
          <p className="lede">
            Neither answer is the right one. Take what fits how you&apos;ll
            actually own it, and leave the rest.
          </p>

          {presentable.length === 0 ? (
            // A session can legitimately open with no offers: trailers,
            // electric bicycles, excavators, zero turns and tractors are not
            // ratable. An empty list under a heading promising options would be
            // worse than saying so.
            <div className="note note--panel">
              <h2>There are no ownership plans for this machine.</h2>
              <p>
                Coverage isn&apos;t offered on this type of machine. Nothing is
                missing from your deal and there&apos;s nothing for you to decide
                here.
              </p>
              <p>Your dealership can still answer any question about owning it.</p>
            </div>
          ) : (
            <>
              {groups.map((g) => (
                <section className="goal-section" id={g.id} key={g.id}>
                  <h2 className="goal-head">{g.goal}</h2>
                  <div className="products">
                    {g.items.map((p) => (
                      <ProductRow
                        key={p.offer.product_code}
                        item={p}
                        price={priceOf(p)}
                        perMonth={
                          hasPayment && rate !== null && term !== null
                            ? productPayment(priceOf(p), rate, term)
                            : null
                        }
                        disposition={decisions[p.offer.product_code]}
                        chosenOptions={options[p.offer.product_code] ?? []}
                        open={!!open[p.offer.product_code]}
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
                </section>
              ))}

              <p className="note">
                Every plan you&apos;re eligible for is listed here. Your earlier
                answers change the order they appear in, never which ones appear.
              </p>

              {withheld.length > 0 && (
                <p className="note">
                  {withheld.length} plan{withheld.length === 1 ? "" : "s"} offered by
                  the provider {withheld.length === 1 ? "is" : "are"} not shown
                  because {withheld.length === 1 ? "it does" : "they do"} not yet
                  have approved pricing and plain-language terms on file. Your
                  dealership can tell you more.
                </p>
              )}

              {/* A different thing entirely, and not a decision anybody made:
                  these were rated but matched nothing in the catalog. Saying so
                  is how it gets noticed at all -- in a self-guided session
                  there is no member of staff watching the screen. */}
              {unmatched.length > 0 && (
                <p className="note note--flag">
                  <b>Please check with your dealership before you finish.</b>{" "}
                  {unmatched.length === 1 ? "An option" : `${unmatched.length} options`}{" "}
                  offered for your machine could not be displayed here, so this
                  list may be incomplete. This is a problem on our end, not a
                  decision about what you qualify for.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {/* ── 3. Payment Plan ──────────────────────────────────────────────── */}
      {step === 2 && (
        <section className="screen">
          <h1 className="display display--sm">What it comes to.</h1>
          <p className="lede">
            {isCash
              ? "You're paying for this outright, so there's no monthly payment. Here's what your choices add to the purchase."
              : "Your deal is already structured. This shows what your choices add to it."}
          </p>

          <div className="panel">
            {/* A cash purchase has no amount financed, no term and no rate.
                Printing those headings with dashes under them would imply a
                loan that does not exist. */}
            {!isCash && (
              <DealTerms
                principal={principal}
                term={term}
                rateLabel={session.financials.rate_label ?? "Rate"}
                rate={rate}
              />
            )}

            {totals ? (
              <>
                <PaymentBreakdown totals={totals} />
                <p className="fine">
                  Calculated from your financed amount of {money(principal!)} over{" "}
                  {term} months at {rate}%
                  {session.financials.rate_source === "apr"
                    ? " annual percentage rate"
                    : " interest"}
                  . The total is figured on the combined amount, not by adding up
                  each plan separately, so it matches your contract.
                </p>
                <p className="fine">
                  Your ownership plan comes to {money(totals.productTotal)} in
                  total across the plans you included.
                </p>
              </>
            ) : isCash ? (
              <>
                {/* The plan is an amount added to the purchase, not to a
                    payment. That is the only honest framing here. */}
                <PlanCostOnly
                  label="Added to your purchase"
                  total={planTotal}
                  lines={presentable
                    .filter((p) => decisions[p.offer.product_code] === "Included")
                    .map((p) => ({ name: p.copy.display_name, amount: priceOf(p) }))}
                />
                <p className="fine">
                  You&apos;re paying for this machine outright, so there&apos;s no
                  monthly payment and no finance charge on anything you include.
                  These are one-time amounts added to what you&apos;re already
                  paying.
                </p>
              </>
            ) : (
              <>
                <PlanCostOnly label="Added to your purchase" total={planTotal} lines={[]} />
                <p className="fine">
                  We can&apos;t show a monthly payment for this deal yet — the
                  financing terms haven&apos;t been finalized. The totals above are
                  correct; your dealership can walk you through what they come to
                  each month.
                </p>
              </>
            )}
          </div>
        </section>
      )}

      {/* ── 4. Your Plan ─────────────────────────────────────────────────── */}
      {step === 3 && (
        <section className="screen">
          <h1 className="display display--sm">Here&apos;s your plan.</h1>
          <p className="lede">
            Everything you were shown, and what you decided about each. Change
            anything you like — your answers are saved as you go.
          </p>

          <div className="panel">
            <h2 className="panel-head">What you were shown</h2>
            <PlanSummary lines={planLines} />
            {presentable.length > 0 && (
              <p className="panel-foot">
                <button type="button" className="linkish" onClick={() => goTo(1)}>
                  Change these decisions
                </button>
              </p>
            )}
          </div>

          <div className="panel">
            <h2 className="panel-head">{totals ? "Payment" : "Your plan"}</h2>
            {totals ? (
              <>
                <PaymentBreakdown totals={totals} />
                <dl className="terms terms--inline">
                  <div>
                    <dt>{session.financials.rate_label ?? "Rate"} and term</dt>
                    <dd>{rate}% · {term} months</dd>
                  </div>
                </dl>
              </>
            ) : (
              <>
                <PlanCostOnly label="Added to your purchase" total={planTotal} lines={[]} />
                <p className="fine">
                  {isCash
                    ? "Paid outright, so there is no monthly payment and no finance charge."
                    : "Financing terms are not finalized, so no monthly payment is shown."}
                </p>
              </>
            )}
          </div>
        </section>
      )}

      {/* ── 5. Acknowledgment ────────────────────────────────────────────── */}
      {step === 4 && (
        <section className="screen">
          <CompletionState vehicleName={vehicleName} term={term}>
            <div className="panel panel--ack">
              <h2 className="panel-head">What you were shown, and what you decided</h2>
              <p>
                Your plan has been saved and prepared for signing. It lists every
                plan you were shown, what you decided about each, and the payment
                those decisions produce.
              </p>
              <p>
                Protection plans are optional. Declining any of them does not
                affect
                {isCash
                  ? " the terms of your sale"
                  : " your credit approval or the terms of your sale"}
                . Pricing was presented by this system rather than negotiated.
              </p>
              <p className="ack-meta">
                {ackState === "working" && "Preparing your record…"}
                {ackState === "done" && "Saved and ready for signing."}
                {ackState === "error" &&
                  "We saved your plan, but couldn't prepare the signing copy. Your dealership can finish this for you."}
                <br />
                Session {session.id}
                <br />
                {session.mode_label} · Prepared{" "}
                {new Date(presentedAt.current).toLocaleString("en-US")}
              </p>
              <p className="panel-foot">
                Your dealership takes it from here — your plan is on your deal
                and joins the rest of your paperwork for signing. Nothing else
                is needed from you on this screen.
              </p>
              <p className="panel-foot panel-foot--plain">
                <button type="button" className="linkish" onClick={() => goTo(3)}>
                  Review your plan again
                </button>
              </p>
            </div>
          </CompletionState>
        </section>
      )}
    </AppShell>
  );
}

/** Surcharges the customer added (lift kit, oversized tires, mud use, turbo). */
function surchargeCost(p: Presentable, chosen: string[]): number {
  return p.offer.surcharge_options
    .filter((o) => chosen.includes(o.code))
    .reduce((a, o) => a + o.cost_delta, 0);
}
