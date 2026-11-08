// scripts/stores-check.mjs: Administration > Stores, in a real browser.
//
// The built app (apps/ownership-planner, `npx next build` first) against the
// mock Edge Functions in scripts/ui-mock, with made-up stores only (migration
// 0059: fni.ps_stores). Checks that:
//   - the page lists the four stores using PS, by full name, with no scrolling;
//   - "Show all stores" lists all nine, each with a "Uses DocuRide PS" switch;
//   - the shared-dealer note shows on both stores of each pair;
//   - turning a store on adds it to the Sessions store choice and the Staff
//     page's ticks, and turning it off takes it away again;
//   - a time zone saves (to fni.ps_stores, in the real function).
// Screenshots go to the folder given as the first argument, if any.
//
//   node --experimental-strip-types scripts/stores-check.mjs [screenshot folder]

import { startMockEdge } from "./ui-mock/edge.mjs";
import { chromium, signedIn, startApp } from "./ui-mock/app.mjs";

const EDGE = 9971, APP = 3516;
const shots = process.argv[2] ?? null;
const edge = await startMockEdge({ port: EDGE, rows: 6 });
const app = await startApp({ appPort: APP, edgePort: EDGE });
const browser = await chromium.launch();
process.on("exit", () => app.stop());
let failed = 0;
const results = [];
const check = (ok, what) => { results.push(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

const names = (page) => page.$$eval("#ad-stores tbody tr .ad-strong", (s) => s.map((x) => x.textContent.trim()));
const noScroll = (page) => page.evaluate(() => document.scrollingElement.scrollHeight <= window.innerHeight + 1 && document.scrollingElement.scrollWidth <= window.innerWidth + 1);
const noteFor = (page, name) => page.$$eval("#ad-stores tbody tr", (trs, n) => {
  const tr = trs.find((t) => t.querySelector(".ad-strong")?.textContent.trim() === n);
  return tr ? [...tr.querySelectorAll(".ad-same-dealer")].map((x) => x.textContent.trim()) : null;
}, name);
const sessionsChoice = async (page) => {
  await page.goto(`${app.base}/admin/sessions`, { waitUntil: "networkidle" });
  return page.locator("#ad-top-tools select option").allTextContents();
};
const staffTicks = async (page) => {
  await page.goto(`${app.base}/admin/staff`, { waitUntil: "networkidle" });
  return [...new Set(await page.$$eval("#ad-staff .ad-staff-store span", (s) => s.map((x) => x.textContent.trim())))];
};
const switchFor = (page, name) => page.getByRole("switch", { name: `Uses DocuRide PS: ${name}` });

try {
  const ctx = await signedIn(browser, app.base);
  const page = await ctx.newPage();

  // ── The default view: the four using PS ─────────────────────────────
  await page.goto(`${app.base}/admin/stores`, { waitUntil: "networkidle" });
  const four = await names(page);
  check(four.length === 4, `default view lists the stores using PS (${four.length}): ${JSON.stringify(four)}`);
  check(four.every((n) => n.includes(",")), "each by its full name");
  check(JSON.stringify(four) === JSON.stringify([...four].sort((a, b) => a.localeCompare(b))), "alphabetical");
  check(await noScroll(page), "the default view does not scroll");
  check(await page.getByRole("switch").count() === 4, "each has a Uses DocuRide PS switch");
  check(JSON.stringify(await noteFor(page, "Mock Powersports, Riverside")) === JSON.stringify(["Same dealer as Mock Equipment, Riverside"]), "the shared-dealer note on a store using PS");
  if (shots) await page.screenshot({ path: `${shots}/stores-default.png` });

  // ── Show all stores ─────────────────────────────────────────────────
  await page.getByRole("link", { name: /Show all stores/ }).click();
  await page.waitForURL(/all=1/);
  await page.waitForLoadState("networkidle");
  const nine = await names(page);
  check(nine.length === 9, `Show all stores lists every store (${nine.length})`);
  check(await page.getByRole("switch").count() === 9, "every store has a switch");
  check(await noScroll(page), "every store fits without scrolling");
  for (const [a, b] of [["Mock Powersports, Riverside", "Mock Equipment, Riverside"], ["Mock Powersports, Hilltop", "Mock Equipment, Hilltop"]]) {
    check(JSON.stringify(await noteFor(page, a)) === JSON.stringify([`Same dealer as ${b}`]), `note on ${a}`);
    check(JSON.stringify(await noteFor(page, b)) === JSON.stringify([`Same dealer as ${a}`]), `note on ${b}`);
  }
  check(JSON.stringify(await noteFor(page, "Mock Chevrolet")) === "[]", "no note on a store with its own dealer");
  if (shots) await page.screenshot({ path: `${shots}/stores-all.png` });

  // ── Turning a store on, then off ────────────────────────────────────
  check(!(await sessionsChoice(page)).includes("Mock Chevrolet"), "before: not in the Sessions store choice");
  check(!(await staffTicks(page)).includes("Mock Chevrolet"), "before: not on the Staff page");
  await page.goto(`${app.base}/admin/stores?all=1`, { waitUntil: "networkidle" });
  await switchFor(page, "Mock Chevrolet").check({ force: true });
  await page.waitForURL(/saved=1/, { timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  check(edge.state.stores.find((s) => s.name === "Mock Chevrolet").uses_ps === true, "the switch saved at once");
  check(page.url().includes("all=1"), "the page stays on every store after the save");
  check(await switchFor(page, "Mock Chevrolet").isChecked(), "the switch shows on after the save");
  check((await sessionsChoice(page)).includes("Mock Chevrolet"), "on: in the Sessions store choice");
  check((await staffTicks(page)).includes("Mock Chevrolet"), "on: on the Staff page");
  await page.goto(`${app.base}/admin/stores?all=1`, { waitUntil: "networkidle" });
  await switchFor(page, "Mock Chevrolet").uncheck({ force: true });
  await page.waitForURL(/saved=1/, { timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  check(edge.state.stores.find((s) => s.name === "Mock Chevrolet").uses_ps === false, "turned off again");
  check(!(await sessionsChoice(page)).includes("Mock Chevrolet"), "off: gone from the Sessions store choice");
  check(!(await staffTicks(page)).includes("Mock Chevrolet"), "off: gone from the Staff page");

  // ── A time zone saves ───────────────────────────────────────────────
  await page.goto(`${app.base}/admin/stores`, { waitUntil: "networkidle" });
  const first = (await names(page))[0];
  const row = page.locator("#ad-stores tbody tr", { has: page.locator(".ad-strong", { hasText: first }) });
  const zones = await row.locator("select option").evaluateAll((o) => o.map((x) => x.value));
  const other = zones.find((z) => z !== "America/New_York");
  await row.locator("select").selectOption(other);
  await row.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/saved=1/, { timeout: 15_000 });
  check(edge.state.stores.find((s) => s.name === first).time_zone === other, `the time zone saved (${other})`);
  await ctx.close();
} catch (err) {
  check(false, `the check ran to the end (${err instanceof Error ? err.message : String(err)})`);
} finally {
  await browser.close();
  console.log(results.join("\n"));
  console.log(failed ? `${failed} failed` : "all passed");
  process.exit(failed ? 1 : 0);
}
