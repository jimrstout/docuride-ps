// scripts/sessions-stores-check.mjs: the Sessions and Staff pages, in a real browser.
//
// The built app (apps/ownership-planner, `npx next build` first) against the
// mock Edge Functions in scripts/ui-mock, with made-up deals only. The mock
// answers as fni-admin-sessions does (migration 0058): an Administrator sees
// every store, Staff only the stores granted. Checks that:
//   - an Administrator sees every session, a store choice at the top right
//     ("All my stores" first), by store then most recent, and the footer says so;
//   - choosing one store shows only its sessions, most recent first, and the
//     choice is remembered on a reload;
//   - search finds a session by customer, and a co-buyer shows under the buyer;
//   - Staff with one store see no store choice, only that store's sessions,
//     and Sessions alone in the menu;
//   - Staff with no stores see "No stores assigned. Ask an administrator for access.";
//   - the Staff page lists each person's role and stores, for an Administrator;
//   - nothing scrolls, at 1366 by 768.
// Screenshots go to the folder given as the first argument, if any.
//
//   node --experimental-strip-types scripts/sessions-stores-check.mjs [screenshot folder]

import { startMockEdge, STORE_IDS } from "./ui-mock/edge.mjs";
import { chromium, signedIn, startApp } from "./ui-mock/app.mjs";

const EDGE = 9961, APP = 3506;
const shots = process.argv[2] ?? null;
const edge = await startMockEdge({ port: EDGE, rows: 6 });
const app = await startApp({ appPort: APP, edgePort: EDGE });
const browser = await chromium.launch();
process.on("exit", () => app.stop());
let failed = 0;
const results = [];
const check = (ok, what) => { results.push(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

// The sessions that match, on any page (SessionPager pages them to fit the screen).
const visibleDeals = (page) => page.$$eval("#ad-sessions tbody tr[data-row]", (trs) => trs.filter((t) => t.dataset.match !== "0").map((t) => t.querySelector("td.ad-deal").textContent.trim()));
const footer = (page) => page.$eval(".ad-panel-foot", (f) => f.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
const noScroll = (page) => page.evaluate(() => document.scrollingElement.scrollHeight <= window.innerHeight + 1 && document.scrollingElement.scrollWidth <= window.innerWidth + 1);

try {
  // ── An Administrator ──────────────────────────────────────────────────
  edge.state.access = { role: "Administrator", storeIds: null };
  let ctx = await signedIn(browser, app.base);
  let page = await ctx.newPage();
  await page.goto(`${app.base}/admin/sessions`, { waitUntil: "networkidle" });
  check((await visibleDeals(page)).length === 6, `Administrator: every session shows (${(await visibleDeals(page)).length})`);
  const choice = page.locator("#ad-top-tools select");
  check(await choice.count() === 1, "Administrator: the store choice is in the top bar");
  const options = await choice.locator("option").allTextContents();
  check(options[0] === "All my stores" && options.length === 3, `Administrator: options ${JSON.stringify(options)}`);
  const sorted = [...options.slice(1)].sort((a, b) => a.localeCompare(b));
  check(JSON.stringify(sorted) === JSON.stringify(options.slice(1)), "Administrator: stores alphabetical by full name");
  const leftOfEmail = await page.evaluate(() => {
    const t = document.querySelector("#ad-top-tools")?.getBoundingClientRect();
    const e = document.querySelector(".ad-me-name")?.getBoundingClientRect();
    return !!t && !!e && t.right <= e.left && t.left > window.innerWidth / 2;
  });
  check(leftOfEmail, "Administrator: the choice sits at the top right, left of the email");
  check(!(await page.$('.ad-toolbar select option[value=""]:text("All stores")')), "Administrator: no All stores filter in the filter row");
  check(/By store, most recent first/.test(await footer(page)), `Administrator: footer "${await footer(page)}"`);
  const storeOrder = await page.$$eval("#ad-sessions tbody tr[data-row]", (trs) => trs.map((t) => t.querySelector("td[data-label=Store]")?.textContent.trim()));
  check(JSON.stringify(storeOrder) === JSON.stringify([...storeOrder].sort((a, b) => a.localeCompare(b))), "Administrator: rows by store");
  check(await noScroll(page), "Administrator: Sessions does not scroll");
  if (shots) await page.screenshot({ path: `${shots}/sessions-administrator.png` });

  // A co-buyer under the buyer, and search by customer.
  const coBuyer = await page.$eval("#ad-sessions td.ad-customer small", (s) => s.textContent.trim()).catch(() => "");
  check(coBuyer === "Jo Sample", `co-buyer on the second line ("${coBuyer}")`);
  await page.fill(".ad-search input", "rentals");
  await page.waitForTimeout(200);
  const found = await page.$$eval("#ad-sessions tbody tr[data-row]:not([hidden]) td.ad-customer .ad-strong", (s) => s.map((x) => x.textContent.trim()));
  check(found.length > 0 && found.every((n) => n === "Mock Trail Rentals LLC"), `search by customer finds ${JSON.stringify(found)}`);
  await page.fill(".ad-search input", "");

  // One store: only its sessions, most recent first, remembered.
  await choice.selectOption(STORE_IDS[0]);
  await page.waitForTimeout(200);
  const oneStore = await page.$$eval("#ad-sessions tbody tr[data-row]", (trs) => [...new Set(trs.filter((t) => t.dataset.match !== "0").map((t) => t.querySelector("td[data-label=Store]").textContent.trim()))]);
  check(oneStore.length === 1 && oneStore[0] === "Mock Store, Mocktown", `one store chosen: ${JSON.stringify(oneStore)}`);
  check(/Most recent first/.test(await footer(page)) && !/By store/.test(await footer(page)), `one store: footer "${await footer(page)}"`);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  check((await page.locator("#ad-top-tools select").inputValue()) === STORE_IDS[0], "the choice is remembered on a reload");
  check((await visibleDeals(page)).length === 3, `remembered: that store's sessions only (${(await visibleDeals(page)).length})`);

  // The Staff page.
  await page.goto(`${app.base}/admin/staff`, { waitUntil: "networkidle" });
  const people = await page.$$eval("#ad-staff tbody tr", (trs) => trs.map((t) => t.querySelector(".ad-strong")?.textContent.trim()));
  check(people.length === 2, `Staff page: ${people.length} people`);
  check(await page.locator("#ad-staff input[type=checkbox]").count() === 4, "Staff page: a tick per store per person");
  check(await page.getByText("Administrator (you)").count() === 1, "Staff page: your own role is not editable");
  check(await page.locator(".ad-nav a", { hasText: "Staff" }).count() === 1, "Administrator: Staff is in the menu");
  check(await noScroll(page), "Staff page does not scroll");
  if (shots) await page.screenshot({ path: `${shots}/staff-administrator.png` });
  await ctx.close();

  // ── Staff with only one store ─────────────────────────────────────────
  edge.state.access = { role: "Staff", storeIds: [STORE_IDS[0]] };
  ctx = await signedIn(browser, app.base);
  page = await ctx.newPage();
  await page.goto(`${app.base}/admin/sessions`, { waitUntil: "networkidle" });
  check(await page.locator("#ad-top-tools select").count() === 0, "Staff with one store: no store choice");
  const stores = await page.$$eval("#ad-sessions tbody tr[data-row] td[data-label=Store]", (t) => [...new Set(t.map((x) => x.textContent.trim()))]);
  check(JSON.stringify(stores) === JSON.stringify(["Mock Store, Mocktown"]), `Staff with one store: only that store's sessions ${JSON.stringify(stores)}`);
  check(/Most recent first/.test(await footer(page)), `Staff with one store: footer "${await footer(page)}"`);
  const menu = await page.$$eval(".ad-nav a", (a) => a.map((x) => x.textContent.trim()));
  check(JSON.stringify(menu) === JSON.stringify(["Sessions"]), `Staff: the menu is ${JSON.stringify(menu)}`);
  if (shots) await page.screenshot({ path: `${shots}/sessions-staff-one-store.png` });
  await page.goto(`${app.base}/admin/staff`, { waitUntil: "networkidle" });
  check(await page.getByText("Only an administrator can change who sees which stores.").count() === 1, "Staff: the Staff page says it is for administrators");
  await ctx.close();

  // ── Staff with no stores ──────────────────────────────────────────────
  edge.state.access = { role: "Staff", storeIds: [] };
  ctx = await signedIn(browser, app.base);
  page = await ctx.newPage();
  await page.goto(`${app.base}/admin/sessions`, { waitUntil: "networkidle" });
  check(await page.getByText("No stores assigned. Ask an administrator for access.").count() === 1, "Staff with no stores: told so");
  check(await page.locator("#ad-sessions").count() === 0, "Staff with no stores: no list");
  await ctx.close();
} catch (err) {
  check(false, `the check ran to the end (${err instanceof Error ? err.message : String(err)})`);
} finally {
  await browser.close();
  console.log(results.join("\n"));
  console.log(failed ? `${failed} failed` : "all passed");
  process.exit(failed ? 1 : 0);
}
