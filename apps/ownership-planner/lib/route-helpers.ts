// lib/route-helpers.ts — shared plumbing for the pass-through route handlers.
import "server-only";
import { NextResponse } from "next/server";
import { EdgeError, isSessionId } from "./edge";

export function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

/** Validate the session ID before anything reaches an Edge Function. */
export function requireSessionId(id: string | undefined) {
  if (!isSessionId(id)) {
    return { ok: false as const, response: noStore({ error: "Invalid session" }, 400) };
  }
  return { ok: true as const, id };
}

/**
 * Forward an Edge Function's status and message rather than flattening
 * everything to 500 -- the UI needs to tell an expired session (410) apart from
 * a missing one (404) apart from a real fault.
 */
export function edgeFailure(err: unknown) {
  if (err instanceof EdgeError) {
    return noStore({ error: err.message, ...(typeof err.body === "object" && err.body ? err.body : {}) }, err.status);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("planner route error:", message);
  return noStore({ error: "Something went wrong loading this plan" }, 500);
}
