// app/prepare/[sessionId]/page.tsx: Prepare menu, on the staff side.
//
// Reached from Details before presenting (docs/multi-provider.md section 25).
// Columns across, categories down: each cell starts from the preset, with its
// fallbacks, and staff can switch it to any rated option, set its price within
// the band, and choose the vehicle's surcharges once for the whole deal.
// Signed-in staff only; the sheet comes from fni-menu-prepare. Dealer cost is
// shown here and never leaves the staff side.

import Link from "next/link";
import { currentOperator } from "@/lib/admin-session";
import { edge, EdgeError, isSessionId } from "@/lib/edge";
import type { PreparePayload } from "@/lib/prepare-model";
import Prepare from "./Prepare";
import "./prepare.css";

export const dynamic = "force-dynamic";

function Plain({ title, body, back }: { title: string; body: string; back?: string }) {
  return (
    <main className="pm-plain">
      <h1>{title}</h1>
      <p>{body}</p>
      {back ? <Link href={back} prefetch={false}>Back to Details</Link> : null}
    </main>
  );
}

export default async function PreparePage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const operator = await currentOperator();
  if (!operator) return <Plain title="Sign in to prepare the menu" body="Prepare menu is for dealership staff. Sign in from Administration, then open it from Details." />;
  if (!isSessionId(sessionId)) return <Plain title="We couldn't find this deal" body="This link doesn't look right. Open it again from Details." />;

  let payload: PreparePayload;
  try {
    payload = await edge.menuPrepare<PreparePayload>(sessionId);
  } catch (err) {
    if (err instanceof EdgeError && err.status === 404) return <Plain title="We couldn't find this deal" body="Open it again from Details." />;
    console.error("prepare menu load failed:", { session: sessionId });
    return <Plain title="Prepare menu is unavailable right now" body="Try again in a moment." back={`/details/${sessionId}`} />;
  }
  if (payload.out_of_date || payload.sheet.categories.length === 0) {
    return (
      <Plain
        title="There is nothing to prepare yet"
        body="The deal needs a current rating first. Press Confirm and Continue on Details, then come back."
        back={`/details/${sessionId}`}
      />
    );
  }
  return <Prepare initial={payload} />;
}
