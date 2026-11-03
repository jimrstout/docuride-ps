// app/verify/[sessionId]/page.tsx: the staff Verify step.
//
// Everything that goes into a TecAssured rate request, on one page, with where
// each value came from beside it. Nothing here is ever shown to a customer, and
// the page deliberately carries no link to or from the planner.
//
// ── Why the provenance column is the point ──────────────────────────────
// A rate is a price somebody is shown. Before this screen existed the planner
// assembled one unattended from a deal nobody had looked at, and two of the
// seventeen fields TecAssured wants for a UTV have no source in the CRM at all.
// So the question this page answers is not "are the fields full" but "where did
// each of these come from, and is that good enough to put a price on".
//
// ── The editing rule, and why it is strict ──────────────────────────────
// A field the CRM owns is read-only here. The deal is the record, the contract
// is written from the deal, and a screen that let someone type a different sale
// price would put the planner and the paperwork out of step with nothing to say
// which was right. Corrections go to CRM and come back through Refresh.
//
// Only two fields are typed here, and both because nothing else in the system
// knows them: engine size (which the VIN decode usually answers) and remaining
// factory warranty months (which nothing answers).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { currentOperator } from "@/lib/admin-session";
import { SignIn, signInNotice } from "@/components/admin/SignIn";
import { edge, EdgeError, isSessionId } from "@/lib/edge";
import type { VerifySheet, Dx1Check as Dx1CheckResult } from "@/lib/types";
import { AUTO_DECODE_TIMEOUT_MS, shouldAutoDecode } from "@/lib/auto-decode";
import { VERIFY_FLASH_COOKIE } from "@/lib/verify-flash";
import { WorkingArea } from "@/components/Working";
import RenderStamp from "@/components/RenderStamp";
import DetailsBody from "./DetailsBody";

export const dynamic = "force-dynamic";

/**
 * The tab says which deal, so several open tabs can be told apart: "Deal 15029
 * Details". The same GET as the page's first read, which Next memoizes within
 * the render, so it costs no second call.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}): Promise<Metadata> {
  const { sessionId } = await params;
  // Signed out, the tab names no deal: the number is deal data too.
  if (!(await currentOperator())) return { title: "Sign in" };
  if (!isSessionId(sessionId)) return { title: "Details" };
  try {
    const sheet = await edge.verifySheet<VerifySheet>(sessionId);
    const deal = sheet.session.deal_number;
    return { title: deal ? `Deal ${deal} Details` : "Details" };
  } catch {
    return { title: "Details" };
  }
}

export default async function DetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { sessionId } = await params;

  // ── Signed-in staff only ───────────────────────────────────────────────
  // The CRM button opens this screen directly. With nobody signed in on this
  // browser, the sign-in form stands in its place, before anything about the
  // deal is read: no number, no buyer, no field. Signing in returns to this
  // same deal's Details. The Edge Functions refuse the read on their own as
  // well (supabase/functions/_shared/staff-gate.ts); this is the screen half.
  const operator = await currentOperator();
  if (!operator) {
    return (
      <WorkingArea>
        <SignIn
          notice={signInNotice(await searchParams)}
          next={isSessionId(sessionId) ? `/details/${sessionId}` : "/admin/sessions"}
        />
      </WorkingArea>
    );
  }

  if (!isSessionId(sessionId)) notFound();

  // ── The F&I check against DX1 ───────────────────────────────────────────
  // What the CRM's Generate gate would be told: the slots the DX1 pull left in
  // the CRM against the live contracts (fni-dx1-check). Refreshed on every
  // load, for signed-in staff. The function answers within 4.5 seconds and
  // never fails loudly; nothing here blocks the page.
  //
  // Started before the deal is read, so the two run side by side rather than
  // one after the other (about 3 seconds saved on every load). Neither uses
  // what the other reads or writes: the check reads the CRM's slots and the
  // live contracts and keeps its result in sessions.dx1_check, which the sheet
  // does not carry; the sheet may record a new CRM sale date, which the check
  // does not read. Its answer is used further down, exactly as before.
  const dx1Promise: Promise<Dx1CheckResult | null> = edge.dx1Check<Dx1CheckResult>(sessionId).catch((err) => {
    console.error(`dx1 check failed for ${sessionId}:`, err instanceof EdgeError ? err.status : "error");
    return null;
  });

  let sheet: VerifySheet;
  try {
    sheet = await edge.verifySheet<VerifySheet>(sessionId);
  } catch (err) {
    if (err instanceof EdgeError && err.status === 404) notFound();
    console.error("verify sheet failed:", err);
    return (
      <div className="vh">
        <main className="console">
          <p className="console-empty">
            This session could not be loaded right now. Try again shortly.
          </p>
        </main>
      </div>
    );
  }

  // ── The automatic VIN decode ─────────────────────────────────────────────
  // Once per session, the first time Verify opens: a VIN, never decoded, never
  // tried. Server side, through the same function as the Decode the VIN button.
  // Never allowed to block this page: it gets a few seconds, and a failure or a
  // timeout is logged and the sheet is shown as it stands. fni-vin-decode
  // records the attempt before calling TecAssured, so an outage costs one try
  // per session. Not in fni-session-start: the CRM button must not wait on
  // TecAssured. See lib/auto-decode.ts.
  if (shouldAutoDecode(sheet)) {
    try {
      await edge.vinDecode<unknown>(sessionId, { auto: true, timeoutMs: AUTO_DECODE_TIMEOUT_MS });
    } catch (err) {
      console.error(`automatic vin decode failed for ${sessionId}:`, err);
    }
    try {
      // Fresh, because this is the same GET as the first read in the same
      // render, and Next would otherwise hand back that first, pre-decode
      // response without making the request.
      sheet = await edge.verifySheet<VerifySheet>(sessionId, { fresh: true });
    } catch (err) {
      // The sheet from before the decode is still a correct sheet to show.
      console.error(`verify sheet reload after decode failed for ${sessionId}:`, err);
    }
  }

  // The one-shot message from whatever action just ran. It arrives in a
  // short-lived cookie, not in the URL, so a provider refusal or a contract
  // number never ends up in the address bar in front of a customer or in a
  // pasted link. See lib/verify-flash.ts.
  const flashCookie = (await cookies()).get(VERIFY_FLASH_COOKIE)?.value ?? null;

  const dx1 = await dx1Promise;

  return (
    <DetailsBody
      sheet={sheet}
      dx1={dx1}
      flashCookie={flashCookie}
      operatorEmail={operator.email}
      sessionId={sessionId}
      renderStamp={
        // New on every render, and last in the page: the busy state of every
        // action that draws the page again ends only once this changes, and
        // it can only change once everything above it has been drawn.
        <RenderStamp />
      }
    />
  );
}
