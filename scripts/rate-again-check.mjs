// scripts/rate-again-check.mjs: Rate again, and the first rate, on Details, in a real browser.
//
// The built app (apps/ownership-planner, `npx next build` first) against the
// mock Edge Functions in scripts/ui-mock, with made-up deals only. The rating
// answers after 15 seconds, past the point where Next 15.5 dropped the page
// drawn again inside a slow answer and left Details on "Rating again..." for
// 90 seconds (the 13759 report, 3 Nov), and on "Rating..." after Verify (deal
// 07982, 6 Nov). For Rate again, and then for Rate on a deal not rated yet
// (Verify, then the first rate), checks that:
//   - the busy state ends within 2 seconds of the answer, not after 90;
//   - the page shows what the rating changed (the product count, the time,
//     the notice; for the first rate, verified and the next step) and the
//     one-line result;
//   - neither the deal (fni-session-verify) nor the DX1 check (fni-dx1-check)
//     is read again for it;
//   - every value on the screen is the same as after a full reload.
// Exits non-zero if any check fails. Needs Playwright and Chromium.
//
//   node --experimental-strip-types scripts/rate-again-check.mjs

import { startMockEdge } from "./ui-mock/edge.mjs";
import { chromium, signedIn, startApp } from "./ui-mock/app.mjs";

const EDGE = 9951, APP = 3496, ANSWER_MS = 15_000;
const SESSION = "20000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** Not rated yet: Rate verifies, then rates. */
const FIRST = "10000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const edge = await startMockEdge({ port: EDGE, delays: { "POST fni-rate-vehicle": ANSWER_MS } });
const app = await startApp({ appPort: APP, edgePort: EDGE });
const browser = await chromium.launch();
process.on("exit", () => app.stop());
let failed = 0;
const results = [];
const check = (ok, what) => { results.push(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

/** What the screen says, without the one-line result an action leaves (a reload never shows it). */
const screenText = (page) =>
  page.evaluate(() => {
    const main = document.querySelector("main")?.cloneNode(true);
    if (!main) return "";
    for (const el of main.querySelectorAll("[data-working-result]")) el.remove();
    return main.innerText.replace(/\s+/g, " ").trim();
  });

/** Press a Details rating button and check what the page does with a 15 second answer. */
async function ratingCase(label, session, button, expect) {
  const ctx = await signedIn(browser, app.base);
  const page = await ctx.newPage();
  await page.goto(`${app.base}/details/${session}`, { timeout: 60_000 });
  const before = await screenText(page);
  check(expect.opens(before), `${label}: Details opens as expected`);

  const calls = () => ({ verify: edge.state.calls["GET fni-session-verify"] ?? 0, dx1: edge.state.calls["POST fni-dx1-check"] ?? 0 });
  const callsBefore = calls();
  let answeredAt = null;
  // When the answer arrives: the response, not the request's "finished",
  // which a streamed server-action reply can report seconds later.
  const onFinished = (r) => { if (answeredAt === null && r.request().method() === "POST" && new URL(r.url()).pathname.startsWith("/details/")) answeredAt = Date.now(); };
  page.on("response", onFinished);

  const pressedAt = Date.now();
  await page.getByRole("button", { name: button, exact: true }).click();
  // Busy within a moment of the press.
  await page.waitForSelector('[aria-busy="true"]', { timeout: 2_000 });
  // And not busy again, well inside the old 90-second wait.
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: ANSWER_MS + 30_000 });
  const clearedAt = Date.now();
  // The request's own "finished" can land a moment after the page has
  // already updated from its answer: wait for it, briefly.
  for (let i = 0; i < 30 && answeredAt === null; i++) await page.waitForTimeout(100);
  check(answeredAt !== null, `${label}: the answer arrived`);
  check(answeredAt !== null && clearedAt - answeredAt <= 2_000, `${label}: busy ended within 2 s of the answer (${answeredAt ? clearedAt - answeredAt : "?"} ms; ${clearedAt - pressedAt} ms after the press)`);

  const after = await screenText(page);
  const result = await page.evaluate(() => document.querySelector("[data-working-result]")?.textContent?.trim() ?? "");
  check(after !== before, `${label}: the page shows what the rating changed`);
  for (const [what, ok] of expect.shows(after, result)) check(ok, `${label}: ${what}`);
  const callsAfter = calls();
  check(callsAfter.verify === callsBefore.verify, `${label}: the deal was not read again (${callsAfter.verify - callsBefore.verify} reads)`);
  check(callsAfter.dx1 === callsBefore.dx1, `${label}: the DX1 check was not run again (${callsAfter.dx1 - callsBefore.dx1} runs)`);

  page.off("response", onFinished);
  await page.reload({ timeout: 60_000 });
  const reloaded = await screenText(page);
  check(reloaded === after, `${label}: every value on the screen is the same as after a full reload`);
  if (reloaded !== after) {
    const a = after.split(" "), b = reloaded.split(" ");
    const at = a.findIndex((w, i) => w !== b[i]);
    console.log(`${label}: first difference near:`, a.slice(Math.max(0, at - 8), at + 8).join(" "), " | reload:", b.slice(Math.max(0, at - 8), at + 8).join(" "));
  }
  await ctx.close();
}

try {
  await ratingCase("Rate again", SESSION, "Rate again", {
    opens: (t) => t.includes("11 products") || t.includes("Rated"),
    shows: (t, result) => [
      ["the new product count is shown", t.includes("12 products")],
      ["the rating's notice is shown", t.includes("Mock notice from rating 2.")],
      [`the result line says so ("${result}")`, /Rated again: 12 products\./.test(result)],
    ],
  });
  await ratingCase("First rate", FIRST, "Rate", {
    opens: (t) => !t.includes("11 products"),
    shows: (t, result) => [
      ["the product count is shown", t.includes("11 products")],
      ["the deal shows verified", t.includes("Verified")],
      ["Prepare presentation is the next step", t.includes("Prepare presentation")],
      [`the result line says so ("${result}")`, /Verified and rated\./.test(result)],
    ],
  });
} catch (err) {
  check(false, `the check ran to the end (${err instanceof Error ? err.message : String(err)})`);
} finally {
  await browser.close();
  console.log(results.join("\n"));
  console.log(failed ? `${failed} failed` : "all passed");
  process.exit(failed ? 1 : 0);
}
