// scripts/sessions-layout-check.mjs: the Sessions page's label, highlight and
// layout, in a real browser.
//
// The built app (apps/ownership-planner, `npx next build` first) against the
// mock Edge Functions in scripts/ui-mock, with made-up customers and the
// stores' full CRM names. Checks that:
//   - the store choice starts with "All locations";
//   - the sidebar and the breadcrumb name the page on screen, on every admin
//     page, whether opened directly or reached from another page;
//   - at 1920 and at 1366 wide, all five rows show the full store location
//     and the full customer name, nothing cut off, and the page does not scroll;
//   - Expires stays on one line, and the vehicle shows in full on hover;
//   - a store name too long for two lines shows its location first, in normal
//     text, and the group under it, smaller and grey.
// Screenshots go to the folder given as the first argument, if any.
//
//   node --experimental-strip-types scripts/sessions-layout-check.mjs [screenshot folder]

import { startMockEdge } from "./ui-mock/edge.mjs";
import { chromium, signedIn, startApp } from "./ui-mock/app.mjs";
import { ADMIN_SECTIONS } from "../apps/ownership-planner/lib/admin-sections.ts";

const EDGE = 9972, APP = 3517;
const shots = process.argv[2] ?? null;
const edge = await startMockEdge({ port: EDGE, rows: 5 });
// Long names, as on Test: the stores' full CRM names, and made-up customers.
const LONG_STORES = [
  "All Seasons Powersports, Barboursville/Huntington",
  "All Seasons Powersports, New Martinsville",
];
const LONG_CUSTOMERS = [
  ["Christopher Alexander Montgomery-Whitfield", null],
  ["Maximilian Bartholomew Featherstonehaugh", "Annabelle Josephine Featherstonehaugh"],
  ["Mock Trail Rentals and Outdoor Adventures LLC", null],
];
edge.state.stores[0].name = LONG_STORES[0];
edge.state.stores[1].name = LONG_STORES[1];
edge.state.dress = (r, i) => ({
  ...r,
  store_name: LONG_STORES[i % 2],
  customer: LONG_CUSTOMERS[i % 3][0],
  co_buyer: LONG_CUSTOMERS[i % 3][1],
  expired: i === 4,
});
const app = await startApp({ appPort: APP, edgePort: EDGE });
const browser = await chromium.launch();
process.on("exit", () => app.stop());
let failed = 0;
const results = [];
const check = (ok, what) => { results.push(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

const noScroll = (page) => page.evaluate(() => document.scrollingElement.scrollHeight <= window.innerHeight + 1 && document.scrollingElement.scrollWidth <= window.innerWidth + 1);
const here = (page) => page.evaluate(() => ({
  nav: [...document.querySelectorAll(".ad-nav a[aria-current=page]")].map((a) => a.textContent.trim()),
  crumb: document.querySelector(".ad-crumb strong")?.textContent.trim() ?? null,
}));

// Every visible row: what the Customer and Store cells show, and whether any of it is cut off.
const rows = (page) => page.$$eval("#ad-sessions tbody tr[data-row]", (trs) => trs.filter((t) => !t.hidden && t.dataset.match !== "0").map((t) => {
  const cut = (el) => !el || el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth;
  const clipped = (el, cell) => { const a = el.getBoundingClientRect(), b = cell.getBoundingClientRect(); return a.bottom > b.bottom + 1 || a.right > b.right + 1; };
  const cust = t.querySelector("td.ad-customer");
  const store = t.querySelector('td[data-label="Store"]');
  const shown = [...store.querySelectorAll(".ad-store-full, .ad-store-place, .ad-store-group")];
  const exp = t.querySelector('td[data-label="Expires"] small');
  const lh = parseFloat(getComputedStyle(exp).lineHeight) || 14;
  const veh = t.querySelector("td.ad-vehicle .ad-rowlink");
  return {
    customer: cust.querySelector(".ad-strong").textContent.trim(),
    coBuyer: cust.querySelector("small")?.textContent.trim() ?? null,
    customerCut: [...cust.querySelectorAll(".ad-strong, small")].some((el) => cut(el) || clipped(el, cust)),
    store: shown.map((el) => el.textContent.trim()).join(" | "),
    storeCut: shown.length === 0 || shown.some((el) => cut(el) || clipped(el, store)),
    expires: exp.textContent.trim(),
    expiresOneLine: exp.getBoundingClientRect().height <= lh * 1.5 && !cut(exp),
    vehicleTitle: veh.getAttribute("title"),
    vehicle: veh.textContent.trim(),
  };
}));

try {
  const ctx = await signedIn(browser, app.base);
  const page = await ctx.newPage();

  // ── The store choice ─────────────────────────────────────────────────
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${app.base}/admin/sessions`, { waitUntil: "networkidle" });
  const options = await page.locator("#ad-top-tools select option").allTextContents();
  check(options[0] === "All locations", `the store choice starts with All locations (${JSON.stringify(options[0])})`);
  check(!options.includes("All my stores"), "no All my stores anywhere in it");

  // ── The page on screen is the page highlighted ───────────────────────
  // The pages the mock Edge Functions can fill. The highlight and breadcrumb
  // come from one shared component (components/admin/AdminNav.tsx) for every
  // page; test/admin-shell.test.mjs maps every section's path.
  const PAGES = ADMIN_SECTIONS.filter((s) => ["/admin/sessions", "/admin/price-sheets", "/admin/stores", "/admin/staff"].includes(s.href));
  for (const s of PAGES) {
    await page.goto(`${app.base}${s.href}`, { waitUntil: "networkidle" });
    const h = await here(page);
    check(JSON.stringify(h.nav) === JSON.stringify([s.label]) && h.crumb === s.label, `${s.label} opened directly: sidebar ${JSON.stringify(h.nav)}, breadcrumb ${h.crumb}`);
  }
  // Reached from another page, through the sidebar: the layout stays, the highlight must not.
  await page.goto(`${app.base}/admin/stores`, { waitUntil: "networkidle" });
  for (const s of [...PAGES.filter((x) => x.href !== "/admin/stores"), PAGES[0]]) {
    await page.locator(".ad-nav a", { hasText: s.label }).click();
    await page.waitForURL((u) => u.pathname === s.href);
    await page.waitForLoadState("networkidle");
    // "Opening..." on the link while the page comes; it must give way once it has.
    const settled = await page.waitForFunction(() => !document.querySelector(".ad-nav a[aria-busy]"), null, { timeout: 5000 }).then(() => true, () => false);
    check(settled, `${s.label} reached from the sidebar: the link stops saying Opening...`);
    const h = await here(page);
    check(JSON.stringify(h.nav) === JSON.stringify([s.label]) && h.crumb === s.label, `${s.label} reached from the sidebar: sidebar ${JSON.stringify(h.nav)}, breadcrumb ${h.crumb}`);
  }
  check((await here(page)).crumb === "Sessions" && new URL(page.url()).pathname === "/admin/sessions", "Stores then Sessions: Sessions highlighted and named");

  // ── The rows at two widths ───────────────────────────────────────────
  for (const [w, hgt] of [[1920, 1080], [1366, 768]]) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.goto(`${app.base}/admin/sessions`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const r = await rows(page);
    check(r.length === 5, `${w}: all five rows show (${r.length})`);
    r.forEach((x, i) => {
      // The list is by store, so match the row's store by what it shows.
      const full = LONG_STORES.find((n) => x.store.includes(n.split(",")[1].trim()));
      const place = full ? full.split(",")[1].trim() : "(no known location)";
      check(LONG_CUSTOMERS.some(([c, b]) => c === x.customer && b === x.coBuyer), `${w} row ${i + 1}: full customer "${x.customer}"${x.coBuyer ? ` with "${x.coBuyer}"` : ""}`);
      check(!x.customerCut, `${w} row ${i + 1}: customer not cut off`);
      check(x.store.includes(place) && !x.storeCut, `${w} row ${i + 1}: store "${x.store}" shows the location, not cut off`);
      check(x.expiresOneLine, `${w} row ${i + 1}: Expires on one line, in full ("${x.expires}")`);
      check(x.vehicleTitle === x.vehicle, `${w} row ${i + 1}: the full vehicle on hover`);
    });
    check(r.some((x) => x.expires === "Ended with sale date"), `${w}: an ended session reads "Ended with sale date"`);
    check(await noScroll(page), `${w}: the page does not scroll`);
    if (shots) await page.screenshot({ path: `${shots}/sessions-${w}.png` });
  }
  // ── A name too long for two lines: the location first, the group under it ──
  const HUGE = "All Seasons Powersports and Marine Superstore of the Greater Ohio Valley, Barboursville/Huntington";
  const before = edge.state.dress;
  edge.state.dress = (r, i) => ({ ...before(r, i), store_name: i === 0 ? HUGE : before(r, i).store_name });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`${app.base}/admin/sessions`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  const split = await page.$$eval("#ad-sessions .ad-store-split", (els) => els.map((e) => ({
    place: e.querySelector(".ad-store-place")?.textContent.trim(),
    group: e.querySelector("small.ad-store-group")?.textContent.trim(),
    grey: getComputedStyle(e.querySelector("small.ad-store-group")).color !== getComputedStyle(e.querySelector(".ad-store-place")).color,
    title: e.getAttribute("title"),
  })));
  check(split.length === 1 && split[0].place === "Barboursville/Huntington" && split[0].group === HUGE.split(",")[0] && split[0].grey && split[0].title === HUGE,
    `too long for two lines: location first, group smaller and grey under it ${JSON.stringify(split)}`);
  check(await page.locator("#ad-sessions .ad-store-split").count() === 1, "only that row splits; the others keep their full name");
  if (shots) await page.screenshot({ path: `${shots}/sessions-split.png` });
  edge.state.dress = before;
  await ctx.close();
} catch (err) {
  check(false, `the check ran to the end (${err instanceof Error ? err.message : String(err)})`);
} finally {
  await browser.close();
  console.log(results.join("\n"));
  console.log(failed ? `${failed} failed` : "all passed");
  process.exit(failed ? 1 : 0);
}
