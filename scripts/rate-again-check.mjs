// scripts/rate-again-check.mjs: Rate again on Details, in a real browser.
//
// The built app (apps/ownership-planner, `npx next build` first) against the
// mock Edge Functions in scripts/ui-mock, with made-up deals only. Rate again
// answers after 15 seconds, past the point where Next 15.5 dropped the page
// drawn again inside a slow answer and left Details on "Rating again..." for
// 90 seconds (the 13759 report, 3 Nov). Checks that:
//   - the busy state ends within 2 seconds of the answer, not after 90;
//   - the page shows what the rating changed (the product count, the time,
//     the notice) and the one-line result;
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

try {
  const ctx = await signedIn(browser, app.base);
  const page = await ctx.newPage();
  await page.goto(`${app.base}/details/${SESSION}`, { timeout: 60_000 });
  const before = await screenText(page);
  check(before.includes("11 products") || before.includes("Rated"), "Details opens rated");

  const calls = () => ({ verify: edge.state.calls["GET fni-session-verify"] ?? 0, dx1: edge.state.calls["POST fni-dx1-check"] ?? 0 });
  const callsBefore = calls();
  let answeredAt = null;
  page.on("requestfinished", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname.startsWith("/details/")) answeredAt = Date.now(); });

  const pressedAt = Date.now();
  await page.getByRole("button", { name: "Rate again" }).click();
  // Busy within a moment of the press.
  await page.waitForSelector('[aria-busy="true"]', { timeout: 2_000 });
  // And not busy again, well inside the old 90-second wait.
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: ANSWER_MS + 30_000 });
  const clearedAt = Date.now();
  check(answeredAt !== null, "the answer arrived");
  check(answeredAt !== null && clearedAt - answeredAt <= 2_000, `busy ended within 2 s of the answer (${answeredAt ? clearedAt - answeredAt : "?"} ms; ${clearedAt - pressedAt} ms after the press)`);

  const after = await screenText(page);
  const result = await page.evaluate(() => document.querySelector("[data-working-result]")?.textContent?.trim() ?? "");
  check(after !== before, "the page shows what the rating changed");
  check(after.includes("12 products"), "the new product count is shown");
  check(after.includes("Mock notice from rating 2."), "the rating's notice is shown");
  check(/Rated again: 12 products\./.test(result), `the result line says so ("${result}")`);
  const callsAfter = calls();
  check(callsAfter.verify === callsBefore.verify, `the deal was not read again (${callsAfter.verify - callsBefore.verify} reads)`);
  check(callsAfter.dx1 === callsBefore.dx1, `the DX1 check was not run again (${callsAfter.dx1 - callsBefore.dx1} runs)`);

  await page.reload({ timeout: 60_000 });
  const reloaded = await screenText(page);
  check(reloaded === after, "every value on the screen is the same as after a full reload");
  if (reloaded !== after) {
    const a = after.split(" "), b = reloaded.split(" ");
    const at = a.findIndex((w, i) => w !== b[i]);
    console.log("first difference near:", a.slice(Math.max(0, at - 8), at + 8).join(" "), " | reload:", b.slice(Math.max(0, at - 8), at + 8).join(" "));
  }
} catch (err) {
  check(false, `the check ran to the end (${err instanceof Error ? err.message : String(err)})`);
} finally {
  await browser.close();
  console.log(results.join("\n"));
  console.log(failed ? `${failed} failed` : "all passed");
  process.exit(failed ? 1 : 0);
}
