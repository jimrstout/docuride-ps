// scripts/busy-check.mjs: every control shows it is working, in a real browser.
//
// The built app (apps/ownership-planner, `npx next build` first) against the
// mock Edge Functions in scripts/ui-mock, with made-up deals only. Every
// answer is slowed, so "busy until the next page is drawn" can be seen:
//   - pressed twice, a link opens one page, and shows busy until that page
//     is drawn: its address showing and its own content on the screen;
//   - on a throttled connection, busy shows within 100 milliseconds;
//   - a link that opens a new tab stays busy until that tab has drawn, and
//     pressed twice opens one tab.
// Exits non-zero if any check fails. Needs Playwright and Chromium.
//
//   node --experimental-strip-types scripts/busy-check.mjs

import { startMockEdge } from "./ui-mock/edge.mjs";
import { chromium, signedIn, startApp } from "./ui-mock/app.mjs";

const EDGE = 9931, APP = 3476, SLOW = 1500;
const edge = await startMockEdge({ port: EDGE, delayMs: 0, rows: 6 });
const app = await startApp({ appPort: APP, edgePort: EDGE });
const browser = await chromium.launch();
process.on("exit", () => app.stop());
let failed = 0;
const results = [];
const check = (ok, what) => { results.push(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

/**
 * Watch from the press until the next page is drawn (its address is showing
 * and its own content, `drawn`, is on the screen): when busy showed, and
 * whether it ever dropped before then.
 */
async function pressAndWatch(page, locator, drawn, { twice = false, throttle = false } = {}) {
  const cdp = await page.context().newCDPSession(page);
  if (throttle) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 25 * 1024 });
  }
  await page.evaluate(({ from, drawn }) => {
    const w = (window.__watch = { pressed: 0, busyAt: null, droppedBeforeDrawn: false, drawnAt: null });
    const busyNow = () => !!document.querySelector(".nav-busy") || !!document.querySelector('[aria-busy="true"]');
    const tick = () => {
      if (!w.pressed) return requestAnimationFrame(tick);
      const t = performance.now() - w.pressed;
      const busy = busyNow();
      if (busy && w.busyAt === null) w.busyAt = t;
      if (location.pathname + location.search !== from && document.querySelector(drawn)) { w.drawnAt = t; return; }
      if (w.busyAt !== null && !busy) w.droppedBeforeDrawn = true;
      requestAnimationFrame(tick);
    };
    document.addEventListener("pointerdown", () => { if (!w.pressed) w.pressed = performance.now(); }, { capture: true, once: true });
    requestAnimationFrame(tick);
  }, { from: new URL(page.url()).pathname + new URL(page.url()).search, drawn });
  if (twice) await locator.dblclick();
  else await locator.click();
  await page.waitForFunction(() => window.__watch.drawnAt !== null, null, { timeout: 30000 });
  const w = await page.evaluate(() => window.__watch);
  if (throttle) await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  return w;
}

async function linkCase(label, path, locate, drawn, { twice = true } = {}) {
  edge.state.delayMs = SLOW;
  const ctx = await signedIn(browser, app.base);
  const page = await ctx.newPage();
  edge.state.delayMs = 0;
  await page.goto(app.base + path, { waitUntil: "networkidle" });
  edge.state.delayMs = SLOW;
  const navs = [];
  page.on("request", (r) => { if (r.isNavigationRequest() || r.headers()["rsc"] === "1") navs.push(r.url()); });
  let w;
  try {
    w = await pressAndWatch(page, locate(page), drawn, { twice });
  } catch (err) {
    check(false, `${label}: the next page was not drawn in 30 seconds (${String(err).split("\n")[0]})`);
    await ctx.close();
    edge.state.delayMs = 0;
    return;
  }
  check(w.busyAt !== null && w.busyAt < 100, `${label}: busy showed at ${w.busyAt?.toFixed(0)} ms`);
  check(!w.droppedBeforeDrawn, `${label}: busy stayed up until the next page was drawn (${w.drawnAt?.toFixed(0)} ms)`);
  const pages = new Set(navs.map((u) => new URL(u).pathname));
  check(pages.size === 1, `${label}: ${twice ? "pressed twice, " : ""}opened ${pages.size} page(s): ${[...pages].join(", ")}`);
  await page.waitForTimeout(200);
  check(!(await page.$(".nav-busy")), `${label}: busy cleared once drawn`);
  await ctx.close();
  edge.state.delayMs = 0;
}

// Sessions: Open, the deal number, the vehicle.
await linkCase("Sessions Open", "/admin/sessions", (p) => p.locator("#ad-sessions td.ad-row-actions a").first(), ".vnext");
await linkCase("Sessions deal number", "/admin/sessions", (p) => p.locator("#ad-sessions td.ad-deal a").first(), ".vnext");
// Administration links.
await linkCase("Administration: Stores", "/admin/sessions", (p) => p.locator(".ad-nav a", { hasText: "Stores" }), ".ad-main");
await linkCase("Administration: Sessions", "/details/20000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa", (p) => p.locator(".home-link"), "#ad-sessions");
// Details: Prepare presentation. The Prepare page has no <main> since its
// layout was condensed: it is drawn when its own sheet (.pm) is on the screen.
await linkCase("Details: Prepare presentation", "/details/20000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa", (p) => p.locator(".vnext a", { hasText: "Prepare presentation" }), ".pm");

// Throttled: busy within 100 ms of the press.
{
  const ctx = await signedIn(browser, app.base);
  const page = await ctx.newPage();
  await page.goto(app.base + "/admin/sessions", { waitUntil: "networkidle" });
  const w = await pressAndWatch(page, page.locator("#ad-sessions td.ad-row-actions a").first(), ".vnext", { throttle: true });
  check(w.busyAt !== null && w.busyAt < 100, `Throttled Open: busy showed at ${w.busyAt?.toFixed(0)} ms`);
  check(!w.droppedBeforeDrawn, `Throttled Open: busy stayed up until drawn (${w.drawnAt?.toFixed(0)} ms)`);
  await ctx.close();
}

// New tab: Present menu and Present storyboard, pressed twice, open one tab
// each and stay busy until that tab has drawn.
for (const label of ["Present menu", "Present storyboard"]) {
  const ctx = await signedIn(browser, app.base);
  const page = await ctx.newPage();
  await page.goto(app.base + "/details/30000003-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { waitUntil: "networkidle" });
  edge.state.delayMs = SLOW;
  const link = page.locator(".vnext a", { hasText: label });
  const tabs = [];
  ctx.on("page", (t) => tabs.push(t));
  await page.evaluate(() => {
    window.__press = 0; window.__busyAt = null;
    document.addEventListener("pointerdown", () => { if (!window.__press) window.__press = performance.now(); }, { capture: true, once: true });
    const tick = () => {
      if (window.__press && window.__busyAt === null && document.querySelector(".nav-busy")) window.__busyAt = performance.now() - window.__press;
      if (window.__busyAt === null) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await link.dblclick();
  const busyAt = await page.evaluate(() => window.__busyAt);
  check(busyAt !== null && busyAt < 100, `${label}: busy showed at ${busyAt?.toFixed(0)} ms`);
  // Busy until the new tab has drawn its page.
  await page.waitForTimeout(SLOW / 2);
  check(!!(await page.$(".nav-busy")), `${label}: still busy while the new tab is loading`);
  await page.waitForFunction(() => !document.querySelector(".nav-busy"), null, { timeout: 20000 }).catch(() => {});
  check(!(await page.$(".nav-busy")), `${label}: busy cleared once the new tab drew its page`);
  await page.waitForTimeout(1500);
  check(tabs.length === 1, `${label}: pressed twice, opened ${tabs.length} tab(s)`);
  edge.state.delayMs = 0;
  await ctx.close();
}

// ── Buttons ──────────────────────────────────────────────────────────────
// Pressed twice: one request reaches the server, the button shows busy from
// the press (within 100 ms), and stays busy until its result is on the
// screen; for a Details action that updates the page from its own answer,
// its result line (the answer's id changes); for the customer's menu, the
// "chosen" screen.
async function buttonCase(label, path, locate, { calls, done, expect = 1 }) {
  const ctx = await signedIn(browser, app.base);
  const page = await ctx.newPage();
  await page.goto(app.base + path, { waitUntil: "networkidle" });
  edge.state.delayMs = SLOW;
  const before = { ...edge.state.calls };
  await page.evaluate((doneJs) => {
    const stampBefore = document.querySelector("[data-working-render]")?.getAttribute("data-working-render") ?? null;
    const answerBefore = document.querySelector("[data-working-result-id]")?.getAttribute("data-working-result-id") ?? null;
    const isDone = new Function("stampBefore", "answerBefore", doneJs);
    const w = (window.__watch = { pressed: 0, busyAt: null, droppedBeforeDone: false, doneAt: null });
    const busyNow = () => !!document.querySelector('[aria-busy="true"], .working-overlay');
    const tick = () => {
      if (!w.pressed) return requestAnimationFrame(tick);
      const t = performance.now() - w.pressed;
      const busy = busyNow();
      if (busy && w.busyAt === null) w.busyAt = t;
      if (isDone(stampBefore, answerBefore)) { w.doneAt = t; return; }
      if (w.busyAt !== null && !busy) w.droppedBeforeDone = true;
      requestAnimationFrame(tick);
    };
    document.addEventListener("pointerdown", () => { if (!w.pressed) w.pressed = performance.now(); }, { capture: true, once: true });
    requestAnimationFrame(tick);
  }, done);
  await locate(page).dblclick();
  try {
    await page.waitForFunction(() => window.__watch.doneAt !== null, null, { timeout: 30000 });
  } catch {
    check(false, `${label}: the result was not drawn in 30 seconds`);
    await ctx.close();
    edge.state.delayMs = 0;
    return;
  }
  const w = await page.evaluate(() => window.__watch);
  await page.waitForTimeout(300);
  const sent = calls.map((k) => (edge.state.calls[k] ?? 0) - (before[k] ?? 0));
  check(w.busyAt !== null && w.busyAt < 100, `${label}: busy showed at ${w.busyAt?.toFixed(0)} ms`);
  check(!w.droppedBeforeDone, `${label}: busy stayed up until the result was drawn (${w.doneAt?.toFixed(0)} ms)`);
  check(sent.every((n) => n === expect), `${label}: pressed twice, sent ${calls.map((k, i) => `${k} x${sent[i]}`).join(", ")}`);
  await ctx.close();
  edge.state.delayMs = 0;
}

// Verify and the first rate, Save changes and Refresh from CRM update Details
// from their own answer, without drawing the page again (7 Nov): each is
// done when its result line is on the screen and nothing is busy.
const DETAILS_ANSWERED = `const now = document.querySelector("[data-working-result-id]")?.getAttribute("data-working-result-id"); return !!now && now !== answerBefore && !document.querySelector('[aria-busy="true"]');`;
await buttonCase("Details: Rate", "/details/10000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa", (p) => p.locator(".vnext button", { hasText: "Rate" }),
  { calls: ["POST fni-session-verify", "POST fni-rate-vehicle"], done: DETAILS_ANSWERED });
// Rate again updates Details from its answer, without drawing the page again
// (speed part 2): it is done when its result line is on the screen.
await buttonCase("Details: Rate again", "/details/20000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa", (p) => p.locator(".vnext button", { hasText: "Rate again" }),
  { calls: ["POST fni-rate-vehicle"], done: `return /Rated again/.test(document.querySelector("[data-working-result]")?.textContent ?? "") && !document.querySelector('[aria-busy="true"]');` });
await buttonCase("Details: Save changes", "/details/10000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa", (p) => p.locator(".vtools button", { hasText: "Save changes" }),
  { calls: ["POST fni-session-verify"], done: DETAILS_ANSWERED });
await buttonCase("Details: Refresh from CRM", "/details/10000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa", (p) => p.locator(".vh-top button", { hasText: "Refresh from CRM" }),
  { calls: ["POST fni-session-verify"], done: DETAILS_ANSWERED });
await buttonCase("Customer menu: Select this package", "/menu/30000003-aaaa-4aaa-8aaa-aaaaaaaaaaaa", (p) => p.locator("button", { hasText: "Select this package" }).first(),
  { calls: ["POST fni-acknowledgment"], done: `return !document.querySelector("button.mn-btn--go") || /chose|Thank|recorded/i.test(document.body.innerText) && !document.querySelector('[aria-busy="true"]');` });

await browser.close();
app.stop();
edge.close();
console.log(results.join("\n"));
console.log(failed === 0 ? "All checks passed." : `${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
