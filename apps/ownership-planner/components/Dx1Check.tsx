// components/Dx1Check.tsx: the F&I check against DX1, on Details.
//
// What the CRM's Generate gate would be told right now: the deal's product
// slots, as the DX1 pull left them in the CRM, against its live contracts
// (supabase/functions/fni-dx1-check). Run when Details loads, for signed-in
// staff only. Blocking lines first, in the warning colour, then the wording
// warnings, then, once, how to fix them. Nothing shown when there is nothing
// to check.
//
// No hooks, so a Node test can render it.

import type { Dx1Check as Result } from "@/lib/types";

export const DX1_FIX =
  "To fix: in DX1, make sure each F&I product is entered on this deal with the same price and term as its contract, " +
  "and remove any product whose contract was voided. Then press Update F-I Products on the DocuRide record and check again.";

export default function Dx1Check({ result }: { result: Result | null }) {
  if (!result) return null;
  if (result.status === "Nothing to check" && result.warnings.length === 0) return null;
  const tone = result.blocking.length > 0 ? "vdx1check--bad" : result.status === "Match" ? "vdx1check--good" : "vdx1check--warn";
  return (
    <div className={`vdx1check ${tone}`} role={result.blocking.length > 0 ? "alert" : "status"}>
      <p className="vdx1check-head">
        F&amp;I check against DX1:{" "}
        <b>
          {result.status === "Match"
            ? "everything matches"
            : result.blocking.length > 0
              ? "fix these before generating documents"
              : result.status === "Problems"
                ? "check these"
                : "not checked"}
        </b>
      </p>
      {result.blocking.length > 0 ? (
        <ul className="vdx1check-list">
          {result.blocking.map((l) => <li key={l}>{l}</li>)}
        </ul>
      ) : null}
      {result.warnings.length > 0 ? (
        <ul className="vdx1check-list vdx1check-list--warn">
          {result.warnings.map((l) => <li key={l}>{l}</li>)}
        </ul>
      ) : null}
      {result.status === "Problems" ? <p className="vdx1check-fix">{DX1_FIX}</p> : null}
    </div>
  );
}
