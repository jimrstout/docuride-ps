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
import type { Dispatch, SetStateAction } from "react";
import type {
  CatalogEntry,
  Disposition,
  OfferRate,
  SessionPayload,
} from "@/lib/types";
import { num } from "@/lib/types";
import { durationOf } from "@/lib/copy";
import { money, planTotals, productPayment, toCents } from "@/lib/money";
import { profileFor, relevanceScore } from "@/lib/profiles";
import { apiPath } from "@/lib/paths";

import AppShell from "@/components/AppShell";
import ProgressStepper from "@/components/ProgressStepper";
import VehicleContext from "@/components/VehicleContext";
import OwnershipQuestion from "@/components/OwnershipQuestion";
import ProductScreen, {
  type Presentable,
  type PresentableTier,
} from "@/components/ProductScreen";
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

/**
 * A screen is what fits in one viewport, and the flow is a list of them.
 *
 * Steps and screens are no longer the same thing. A step is what the customer
 * sees in the progress rail; several screens can belong to one. Discovery is
 * two screens because two question groups do not fit in 768px with the control
 * bar visible, and Care & Protection is one screen per product for the same
 * reason -- and because a product deserves a screen to itself anyway.
 */
type ScreenSpec =
  | { kind: "intro"; step: 0 }
  | { kind: "question"; step: 0; qIndex: number }
  | { kind: "product"; step: 1; pIndex: number }
  | { kind: "empty"; step: 1 }
  | { kind: "payment"; step: 2 }
  | { kind: "plan"; step: 3 }
  | { kind: "ack"; step: 4 };

export default function Planner({ initial }: { initial: SessionPayload }) {
  const { session } = initial;
  const [at, setAt] = useState(0);
  const [furthest, setFurthest] = useState(0);

  const [decisions, setDecisions] = useState<Record<string, Disposition>>(() => {
    const resumed: Record<string, Disposition> = {};
    for (const s of initial.selections ?? []) {
      resumed[s.provider_product_id] = s.disposition;
    }
    return resumed;
  });

  // Which tier of each family, keyed by family code, and which rate of each
  // tier, keyed by product code.
  //
  // Both default rather than starting empty, because a family screen with no
  // tier and no length chosen cannot show a price, and a menu with no price is
  // not a menu. The defaults are the least expensive end of each axis: the
  // cheapest tier, the shortest term, the smallest deductible. Defaulting to
  // the longest term and the lowest deductible would be defaulting to the most
  // expensive configuration, which is a pressure pattern and not one this
  // planner uses. The Include / I'll manage decision still starts empty.
  const [tierChoice, setTierChoice] = useState<Record<string, string>>({});
  const [rateChoice, setRateChoice] = useState<Record<string, string>>(() => {
    const resumed: Record<string, string> = {};
    for (const sel of initial.selections ?? []) {
      if (sel.rate_unique_id) resumed[sel.provider_product_id] = sel.rate_unique_id;
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

    // A family is shown when at least one of its tiers can honestly be shown.
    // A tier that has no copy, or no sellable rate, is dropped from the tier
    // list rather than taking the whole family down with it: a customer can
    // still choose Bronze if Platinum's copy is unwritten.
    for (const family of initial.offer?.families ?? []) {
      const tiers: PresentableTier[] = [];

      for (const tier of family.tiers) {
        const copy = copyByCode.get(tier.product_code);
        const sellable = tier.rates.filter((r) => r.retail_price !== null);
        const fromPrice = sellable.length > 0
          ? Math.min(...sellable.map((r) => r.retail_price as number))
          : null;

        // Filtering by genuine eligibility is correct. Filtering for relevance
        // is steering, and is not done anywhere here. The exclusions below are
        // neither: a tier with no price or no plain-language copy cannot be
        // presented honestly, which is exactly what the catalog exists to
        // enforce.
        //
        // Order matters. A tier with no catalog row at all is not a withheld
        // product, it is one we failed to recognise, so it is checked first and
        // reported separately rather than folded in with the deliberate cases.
        if (!copy) {
          missing.push({ name: tier.product_name, code: tier.product_code });
          continue;
        }
        if (fromPrice === null) {
          bad.push({
            name: tier.product_name,
            why: tier.rates[0]?.unpriced_reason ?? "No price available",
          });
          continue;
        }
        if (!copy.is_presentable) {
          bad.push({
            name: copy.display_name || tier.product_name,
            why: "No approved plain-language description on file yet",
          });
          continue;
        }

        // Only the rates that carry a price. A rate no band covers cannot be
        // offered, and offering the length without a price is worse.
        tiers.push({ tier: { ...tier, rates: sellable }, copy, fromPrice });
      }

      if (tiers.length > 0) ok.push({ family_code: family.family_code, tiers });
    }

    // Discovery reorders. It never removes. A family is scored by whichever of
    // its tiers scores highest, so a relevant Platinum lifts the whole family.
    const scoreOf = (f: Presentable) =>
      Math.max(...f.tiers.map((t) => relevanceScore(t.copy.relevance_tags, t.copy.goal, allAnswers)));
    const orderOf = (f: Presentable) =>
      Math.min(...f.tiers.map((t) => t.copy.display_order));

    ok.sort((a, b) => {
      const d = scoreOf(b) - scoreOf(a);
      return d !== 0 ? d : orderOf(a) - orderOf(b);
    });

    return { presentable: ok, withheld: bad, unmatched: missing };
  }, [initial.offer, copyByCode, allAnswers]);

  // The flow, as a list of screens. Rebuilt when the product list changes,
  // which is why the customer's position is kept as an index into it rather
  // than as a step number.
  const screens: ScreenSpec[] = useMemo(() => {
    const out: ScreenSpec[] = [{ kind: "intro", step: 0 }];
    profile.questions.forEach((_, qIndex) => out.push({ kind: "question", step: 0, qIndex }));
    if (presentable.length === 0) out.push({ kind: "empty", step: 1 });
    else presentable.forEach((_, pIndex) => out.push({ kind: "product", step: 1, pIndex }));
    out.push({ kind: "payment", step: 2 }, { kind: "plan", step: 3 }, { kind: "ack", step: 4 });
    return out;
  }, [profile.questions, presentable]);

  const screen = screens[Math.min(at, screens.length - 1)];
  const step = screen.step;

  // When each product was actually put in front of this customer.
  //
  // One product to a screen means there is no single moment the set was
  // presented, so each is stamped the first time its own screen is shown and
  // the stamp rides with that product's decision. A resumed session keeps
  // whatever was recorded the first time round -- the customer saw it then,
  // and re-stamping it now would overwrite the fact with the retelling.
  //
  // Keyed by FAMILY, because the family is what has a screen. Every tier in it
  // was on that screen, one keypress away, so they all carry the same stamp.
  // On resume the stamp is recovered from any tier that already has one: they
  // were written together, and the earliest is the one that is true.
  //
  // The resumed stamps are recovered in the initializer rather than in an
  // effect, so they are in place before the first commit can stamp anything.
  // An effect would have raced the stamping one below and could overwrite a
  // real presentation time with the time of the resume.
  const shownAt = useRef<Record<string, string>>(
    (() => {
      const byProduct = new Map<string, string>();
      for (const sel of initial.selections ?? []) {
        if (sel.presented_at) byProduct.set(sel.provider_product_id, sel.presented_at);
      }

      const byFamily: Record<string, string> = {};
      for (const p of presentable) {
        // The earliest stamp across the family's tiers. They were written in one
        // save, so they agree; taking the earliest is what keeps them agreeing
        // if a later save ever adds a tier that was not there the first time.
        const stamps = p.tiers
          .map((t) => byProduct.get(t.tier.product_code))
          .filter((v): v is string => v !== undefined)
          .sort();
        if (stamps.length > 0) byFamily[p.family_code] = stamps[0];
      }
      return byFamily;
    })()
  );

  useEffect(() => {
    if (screen.kind !== "product") return;
    const family = presentable[screen.pIndex]?.family_code;
    if (family && !shownAt.current[family]) {
      shownAt.current[family] = new Date().toISOString();
    }
  }, [screen, presentable]);

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

  /** The tier in force for a family: the customer's, else the cheapest. */
  const tierOf = useCallback(
    (p: Presentable): PresentableTier =>
      p.tiers.find((t) => t.tier.product_code === tierChoice[p.family_code]) ?? p.tiers[0],
    [tierChoice]
  );

  /** The rate in force for a tier: the customer's, else the shortest. */
  const rateOf = useCallback(
    (t: PresentableTier): OfferRate | undefined =>
      t.tier.rates.find((r) => r.rate_unique_id === rateChoice[t.tier.product_code]) ??
      t.tier.rates[0],
    [rateChoice]
  );

  const priceOf = useCallback(
    (p: Presentable): number | null => {
      const t = tierOf(p);
      const r = rateOf(t);
      if (!r || r.retail_price === null) return null;
      return r.retail_price + surchargeCost(r, options[t.tier.product_code] ?? []);
    },
    [tierOf, rateOf, options]
  );

  const includedPrices = presentable
    .filter((p) => decisions[p.family_code] === "Included")
    .map(priceOf)
    .filter((n): n is number => n !== null);

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
          // One row per TIER, not per family. Every product the customer was
          // shown is recorded, including the tiers they did not take and the
          // families they are managing themselves: a record of a presentation
          // that lists only what was bought is not a record of the presentation.
          // Only the tier actually chosen, in a family they included, is
          // Included.
          decisions: presentable.flatMap((p) => {
            const decided = decisions[p.family_code];
            const chosenTier = tierOf(p);

            return p.tiers.map((t) => {
              const isChosen = t.tier.product_code === chosenTier.tier.product_code;
              const rate = rateOf(t);
              const chosen = options[t.tier.product_code] ?? [];
              const price =
                rate === undefined || rate.retail_price === null
                  ? null
                  : rate.retail_price + surchargeCost(rate, chosen);

              return {
                product_code: t.tier.product_code,
                product_type: t.tier.product_type,
                product_name: t.copy.display_name,
                disposition:
                  isChosen && decided === "Included" ? "Included" : "Managed by Customer",
                rate_unique_id: rate?.rate_unique_id ?? null,
                term_months: rate?.term_months ?? null,
                term_miles: rate?.term_miles ?? null,
                deductible: rate?.deductible ?? null,
                dealer_cost: rate?.dealer_cost ?? null,
                retail_price: price,
                customer_price: price,
                selected_options: chosen,
                rate_snapshot: rate?.raw ?? t.tier.raw,
                // The moment this family's screen was shown. Null until it has
                // been, so a family the customer has not reached is not recorded
                // as presented.
                presented_at: shownAt.current[p.family_code] ?? null,
              };
            });
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

  const decided = presentable.filter((p) => decisions[p.family_code]).length;

  const vehicleName = [
    session.vehicle.year,
    session.vehicle.make,
    session.vehicle.model,
    session.vehicle.submodel,
  ]
    .filter(Boolean)
    .join(" ");

  const goTo = useCallback((next: number) => {
    setAt(next);
    setFurthest((f) => Math.max(f, next));
  }, []);

  /** The first screen belonging to a step, for the progress rail. */
  const firstScreenOfStep = useCallback(
    (target: number) => Math.max(0, screens.findIndex((sc) => sc.step === target)),
    [screens]
  );

  // How far into the product run the customer has got. The rail lists every
  // option so they can see what is coming, but only lets them jump back to one
  // they have actually been shown -- skipping ahead would put a decision on a
  // record beside a presented_at that never happened.
  const furthestProduct = useMemo(() => {
    let best = -1;
    screens.slice(0, furthest + 1).forEach((sc) => {
      if (sc.kind === "product") best = Math.max(best, sc.pIndex);
    });
    return best;
  }, [screens, furthest]);

  // One line per family, naming the tier the customer settled on and the term
  // they picked, so the page they take home says the same thing the screen did.
  const planLines: PlanLine[] = presentable.map((p) => {
    const t = tierOf(p);
    return {
      code: p.family_code,
      name: t.copy.display_name,
      duration: durationOf(rateOf(t), t.copy.coverage_duration),
      price: priceOf(p),
      disposition: decisions[p.family_code],
    };
  });

  // ── Footer wiring ───────────────────────────────────────────────────────
  const onBack = () => goTo(Math.max(0, at - 1));
  const onNext = () => {
    if (screen.kind === "plan") void finish();
    if (at < screens.length - 1) goTo(at + 1);
  };

  const nextLabel =
    screen.kind === "intro" ? "Begin"
    : screen.kind === "plan" ? "Finish & save plan"
    : "Continue";

  // A product screen will not let the customer past it undecided. Skipping
  // would record a decision they never made.
  const undecidedHere =
    screen.kind === "product" &&
    !decisions[presentable[screen.pIndex].family_code];

  const status =
    undecidedHere ? "Choose one to continue"
    : saveState === "saving" ? "Saving…"
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
      {step === 1 && presentable.length > 0 && (
        <nav className="railnav" aria-label="Your options">
          <p className="eyebrow">Your options</p>
          <ol>
            {presentable.map((p, i) => {
              const d = decisions[p.family_code];
              const here = screen.kind === "product" && screen.pIndex === i;
              const reached = i <= furthestProduct;
              return (
                <li key={p.family_code} className={here ? "is-here" : ""}>
                  <button
                    type="button"
                    disabled={!reached}
                    aria-current={here ? "true" : undefined}
                    onClick={() => goTo(firstScreenOfStep(1) + i)}
                  >
                    <span className="railnav-name">{tierOf(p).copy.display_name}</span>
                    <span className="railnav-state">
                      {d === "Included" ? "Included" : d ? "Managing" : here ? "Deciding" : "—"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
    </VehicleContext>
  );

  return (
    <AppShell
      dealerGroupName={initial.dealer_group_name}
      stepper={
        <ProgressStepper
          steps={STEPS}
          current={step}
          furthest={screens[Math.min(furthest, screens.length - 1)].step}
          onGo={(target) => goTo(firstScreenOfStep(target))}
        />
      }
      rail={rail}
      footer={
        <ActionFooter
          onBack={onBack}
          showBack={at > 0}
          onNext={onNext}
          nextLabel={nextLabel}
          showNext={at < screens.length - 1}
          nextDisabled={undecidedHere}
          status={status}
        />
      }
    >
      {screen.kind !== "product" && (
        <p className="eyebrow eyebrow--rule">{EYEBROWS[step]}</p>
      )}

      {/* ── 1a. Opening ──────────────────────────────────────────────────
          Sets the frame before anything is asked. No warnings, and nothing
          about the machine failing: the premise is that they bought something
          worth owning. */}
      {screen.kind === "intro" && (
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

      {/* ── 1b. Your Ownership, one question to a screen ───────────────── */}
      {screen.kind === "question" && (
        <section className="screen">
          <h1 className="display">
            {screen.qIndex === 0 ? "Your plan starts with you." : "And what you want from it."}
          </h1>
          <p className="lede">
            {screen.qIndex === 0
              ? "All available options are presented either way — your answers only change what comes first."
              : "Last one. This orders what you see, and nothing else."}
          </p>

          <OwnershipQuestion
            question={profile.questions[screen.qIndex]}
            chosen={answers[profile.questions[screen.qIndex].id] ?? []}
            onToggle={(value) =>
              setAnswers((a) => {
                const id = profile.questions[screen.qIndex].id;
                const cur = a[id] ?? [];
                return {
                  ...a,
                  [id]: cur.includes(value)
                    ? cur.filter((x) => x !== value)
                    : [...cur, value],
                };
              })
            }
          />
        </section>
      )}

      {/* ── 2. Care & Protection, one product to a screen ──────────────── */}
      {screen.kind === "empty" && (
        <section className="screen">
          <h1 className="display">Nothing to decide here.</h1>
          {/* A session can legitimately open with no offers: trailers, electric
              bicycles, excavators, zero turns and tractors are not ratable. An
              empty list under a heading promising options would be worse than
              saying so. */}
          <div className="note note--panel">
            <p>
              Ownership plans aren&apos;t offered on this type of machine. Nothing
              is missing from your deal and there&apos;s nothing for you to decide.
            </p>
            <p>Your dealership can still answer any question about owning it.</p>
          </div>
        </section>
      )}

      {screen.kind === "product" && (
        <section className="screen screen--wide">
          <FamilyScreen
            family={presentable[screen.pIndex]}
            index={screen.pIndex + 1}
            total={presentable.length}
            tierOf={tierOf}
            rateOf={rateOf}
            priceOf={priceOf}
            hasPayment={hasPayment}
            rate={rate}
            term={term}
            decisions={decisions}
            options={options}
            dealerGroupName={initial.dealer_group_name}
            copyTemplates={initial.copy ?? {}}
            setTierChoice={setTierChoice}
            setRateChoice={setRateChoice}
            setDecisions={setDecisions}
            setOptions={setOptions}
          />
        </section>
      )}

      {/* ── 3. Payment Plan ──────────────────────────────────────────────── */}
      {screen.kind === "payment" && (
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
                    .filter((p) => decisions[p.family_code] === "Included")
                    .map((p) => ({
                      name: tierOf(p).copy.display_name,
                      amount: priceOf(p),
                    }))
                    // A family with no priced rate never reaches a screen, so
                    // this drops nothing in practice; it is here so an unpriced
                    // line can never be summed in as a zero.
                    .filter((l): l is { name: string; amount: number } =>
                      l.amount !== null
                    )}
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
      {screen.kind === "plan" && (
        <section className="screen">
          <h1 className="display display--sm">Here&apos;s your plan.</h1>
          <p className="lede">
            Everything you were shown, and what you decided. Saved as you go.
          </p>

          <div className="review">
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
          </div>
        </section>
      )}

      {/* ── 5. Acknowledgment ────────────────────────────────────────────── */}
      {screen.kind === "ack" && (
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

/**
 * Surcharges on top of a rate (lift kit, oversized tires, commercial use).
 *
 * Options hang off the RATE, not the product, and a mandatory one is counted
 * whether or not the customer ticked it: it is not a choice, and leaving it out
 * of the price would quote a figure the provider will not honour.
 */
function surchargeCost(rate: OfferRate, chosen: string[]): number {
  return rate.options
    .filter((o) => o.mandatory || chosen.includes(o.code))
    .reduce((a, o) => a + o.cost_delta, 0);
}

// ── The family screen's wiring ────────────────────────────────────────────
//
// A thin adapter, not a second screen. ProductScreen renders; this resolves
// which tier and which rate are in force and hands over the four setters. It
// exists because the call site was accumulating a dozen
// `presentable[screen.pIndex]` repetitions, and a screen index spelled out
// twelve times is a screen index that will eventually be spelled wrong once.
function FamilyScreen({
  family,
  index,
  total,
  tierOf,
  rateOf,
  priceOf,
  hasPayment,
  rate,
  term,
  decisions,
  options,
  dealerGroupName,
  copyTemplates,
  setTierChoice,
  setRateChoice,
  setDecisions,
  setOptions,
}: {
  family: Presentable;
  index: number;
  total: number;
  tierOf: (p: Presentable) => PresentableTier;
  rateOf: (t: PresentableTier) => OfferRate | undefined;
  priceOf: (p: Presentable) => number | null;
  hasPayment: boolean;
  rate: number | null;
  term: number | null;
  decisions: Record<string, Disposition>;
  options: Record<string, string[]>;
  dealerGroupName: string | null;
  copyTemplates: Record<string, string>;
  setTierChoice: Dispatch<SetStateAction<Record<string, string>>>;
  setRateChoice: Dispatch<SetStateAction<Record<string, string>>>;
  setDecisions: Dispatch<SetStateAction<Record<string, Disposition>>>;
  setOptions: Dispatch<SetStateAction<Record<string, string[]>>>;
}) {
  const tier = tierOf(family);
  const chosenRate = rateOf(tier);
  const price = priceOf(family);
  const code = tier.tier.product_code;

  return (
    <ProductScreen
      item={family}
      index={index}
      total={total}
      chosenTier={tier}
      chosenRate={chosenRate}
      price={price}
      perMonth={
        hasPayment && price !== null && rate !== null && term !== null
          ? productPayment(price, rate, term)
          : null
      }
      disposition={decisions[family.family_code]}
      chosenOptions={options[code] ?? []}
      dealerGroupName={dealerGroupName}
      copyTemplates={copyTemplates}
      onChooseTier={(productCode) =>
        setTierChoice((st) => ({ ...st, [family.family_code]: productCode }))
      }
      onChooseRate={(rateUniqueId) =>
        setRateChoice((st) => ({ ...st, [code]: rateUniqueId }))
      }
      onDecide={(d) => setDecisions((st) => ({ ...st, [family.family_code]: d }))}
      onOption={(optionCode, on) =>
        setOptions((st) => {
          const cur = st[code] ?? [];
          return {
            ...st,
            [code]: on ? [...cur, optionCode] : cur.filter((c) => c !== optionCode),
          };
        })
      }
    />
  );
}
