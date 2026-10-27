// Rating errors sized and worded for people (2026-10-27). One plain line per
// failure, chosen by its kind, with the exact text behind "Show details" and
// a "Copy error" button. The kind is decided in one place:
// apps/ownership-planner/lib/rating-error.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  copyErrorText,
  errorStamp,
  hasMoreDetail,
  ratingErrorHeadline,
  ratingErrorKind,
  ratingErrorSummary,
  ratingFailures,
} from "../apps/ownership-planner/lib/rating-error.ts";
import { IN_SERVICE_DATE_MISSING, SALE_DATE_MISSING } from "../supabase/functions/_shared/deal-dates.ts";

const src = (rel) => readFileSync(new URL(`../apps/ownership-planner/${rel}`, import.meta.url), "utf8");
const RA = "Riders Advantage";
// Deal 15029's stored error, as TecAssured sent it.
const SOAP =
  "TecAssured refused the rate request: Client received SOAP Fault from server: The formatter threw an exception " +
  "while trying to deserialize the message: There was an error while trying to deserialize parameter " +
  "http://arch.stoneeagle.com/MenuIntegration/:RateRequest. The InnerException message was 'There was an error " +
  "deserializing the object of type ARCHService.Api.DTOs.RateRequest. The value '' cannot be parsed as the type " +
  "'DateTime'.'.  Please see InnerException for more details.";

test("the provider's own system failing reads as theirs, with try again later", () => {
  const said = `${RA} could not rate this deal. Their system returned an error. Try again later.`;
  for (const t of [
    SOAP,
    "TecAssured API call failed (500): Internal Server Error",
    "Rating failed: The signal has been aborted",
    "Rating failed: request timed out after 30000ms",
    "TecAssured's https://example.test/requiredproperties is not answering, so the properties needed to rate a MCYC cannot be determined.",
    "Rating failed: fetch failed",
  ]) {
    assert.equal(ratingErrorKind(t), "provider", t);
    assert.equal(ratingErrorSummary(RA, t), said);
  }
});

test("a login the provider refused, or one not set up, asks for an administrator", () => {
  const said = `${RA} did not accept our login. Contact an administrator.`;
  for (const t of [
    "TecAssured authentication failed: invalid credentials",
    "TecAssured loginrequest failed (401): Unauthorized",
    "TecAssured loginassertion failed (403): Forbidden",
    "TecAssured refused the session immediately after a successful login: Session expired",
    "Store abc's Riders Advantage account has no login or no Dealer ID, so Riders Advantage cannot be called for it.",
    "Store abc maps to Riders Advantage credential 123, which is missing or inactive.",
  ]) {
    assert.equal(ratingErrorKind(t), "login", t);
    assert.equal(ratingErrorSummary(RA, t), said);
  }
});

test("our own checks before sending keep their plain-English reason", () => {
  assert.equal(ratingErrorKind(SALE_DATE_MISSING), "ours");
  assert.equal(ratingErrorSummary(RA, SALE_DATE_MISSING), SALE_DATE_MISSING.replace("on Verify", "on Details"));
  assert.equal(ratingErrorKind(IN_SERVICE_DATE_MISSING), "ours");
  assert.match(ratingErrorSummary(RA, IN_SERVICE_DATE_MISSING), /^In-service date is missing\..*on Details\.$/);
  assert.equal(ratingErrorSummary(RA, "No price sheet published for BRP."), "No price sheet published for BRP.");
  assert.equal(
    ratingErrorSummary(RA, "No TecAssured vehicle type for this unit. The deal's body type is either blank or not in BODY_TYPE_MAP (_shared/vehicle-types.ts), so there is nothing to ask the provider about."),
    "No vehicle type is set for this deal. Choose one under Vehicle type on Details, then rate again."
  );
  assert.equal(ratingErrorSummary("BRP", "BRP has no adapter to rate with."), "BRP is not set up to rate deals yet. Contact an administrator.");
});

test("anything else says only that it could not rate", () => {
  assert.equal(ratingErrorKind("Something odd happened."), "unknown");
  assert.equal(ratingErrorSummary(RA, "Something odd happened."), `${RA} could not rate this deal.`);
  assert.equal(ratingErrorKind(""), "unknown");
  assert.equal(ratingErrorSummary("", null), "The provider could not rate this deal.");
});

test("the failures come from the exact texts, or from the older one-line detail", () => {
  const exact = [{ provider: RA, text: SOAP, at: "2026-10-27T13:03:29Z" }];
  assert.deepEqual(ratingFailures({ detail: `${RA}: ${SOAP}`, at: "x", failures: exact }), exact);
  assert.deepEqual(ratingFailures({ detail: `${RA}: ${SOAP}`, at: "2026-10-27T13:03:29Z" }), exact);
  assert.deepEqual(ratingFailures({ detail: null, at: null }), []);
  assert.equal(
    ratingErrorHeadline(exact),
    `${RA} could not rate this deal. Their system returned an error. Try again later.`
  );
  assert.equal(ratingErrorHeadline([]), null);
  assert.equal(hasMoreDetail(exact[0]), true);
  assert.equal(hasMoreDetail({ provider: RA, text: "No price sheet published for BRP.", at: null }), false);
});

test("Copy error gives the deal, the provider and time, and the exact text", () => {
  assert.equal(errorStamp("2026-10-27T13:03:29Z"), "27 Oct 2026 13:03 UTC");
  assert.equal(errorStamp(null), null);
  assert.equal(
    copyErrorText("15029", { provider: RA, text: SOAP, at: "2026-10-27T13:03:29Z" }),
    `Deal 15029\n${RA}, 27 Oct 2026 13:03 UTC\n${SOAP}`
  );
  assert.equal(copyErrorText(null, { provider: RA, text: "x", at: null }), `Deal (no number)\n${RA}\nx`);
});

test("the session list shows the summary and opens the full text under the row", () => {
  const page = src("app/admin/sessions/page.tsx");
  assert.match(page, /ratingErrorHeadline\(failures\)/);
  assert.match(page, /<RowDetailsToggle target=\{whyRowId\(row\)\} \/>/);
  assert.match(page, /<tr className="ad-why-row" id=\{whyRowId\(row\)\} hidden>\s*<td colSpan=\{8\}>/);
  const toggle = src("components/admin/RowDetailsToggle.tsx");
  assert.match(toggle, /aria-expanded=\{open\}/);
  assert.match(toggle, /open \? "Hide details" : "Show details"/);
  const full = src("components/RatingErrorText.tsx");
  assert.match(full, /<pre className="rating-error-text"/);
  assert.match(full, /<CopyErrorButton text=\{copyErrorText\(deal, f\)\} \/>/);
  const css = src("app/admin/admin.css");
  assert.match(css, /\.ad-table tr\[data-row\]\[hidden\] \+ tr\.ad-why-row \{ display: none; \}/);
  assert.match(css, /#ad-sessions tr\.ad-why-row:not\(\[hidden\]\) \{ display: block;/);
  const g = src("app/globals.css");
  assert.match(g, /\.rating-error-text \{[^}]*max-height: 12rem; overflow: auto;[^}]*overflow-wrap: anywhere/);
});
