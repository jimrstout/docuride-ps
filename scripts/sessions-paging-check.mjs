// scripts/sessions-paging-check.mjs: the Sessions list in a real browser.
//
// Checks, at 1280x800, 1366x768, 1440x900 and 1920x1080, with 6 and with 60
// mock sessions:
//   - nothing scrolls: not the page, not sideways, not inside the table;
//   - every session is reachable by paging, each exactly once;
//   - a filter applies before paging, and changing one goes back to page 1.
//
// It runs the built app (apps/ownership-planner, `npx next build` first)
// against a mock of the two Edge Functions the list reads, with made-up
// sessions only. Nothing reaches Supabase. Needs Playwright and Chromium,
// which the cloud containers have; the GitHub workflow does not run it.
//
//   node --experimental-strip-types scripts/sessions-paging-check.mjs
//
// Exits non-zero if any check fails.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import { mintConsoleCookie } from "../apps/ownership-planner/lib/console-cookie.ts";

const { chromium } = createRequire(import.meta.url)("playwright");
const SECRET = "mock-secret-for-a-local-check-only";
const EDGE_PORT = 9921;
const APP_PORT = 3466;
const APP = new URL("../apps/ownership-planner/", import.meta.url).pathname;
const STORES = ["Mock Store, Mocktown", "Second Store, Elsewhere"];
const STORE_IDS = ["5a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "5b000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
const STATES = ["Rated", "Failed", "Pending", "Not Offered"];

let rows = 6;
function sessions(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${(i + 1).toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    deal_number: String(90000 + i), status: "Open", mode: "Finance",
    store_name: STORES[i % 2], store_id: STORE_IDS[i % 2], customer: "Pat Example", year: 2026, make: "Mockmake", model: "Trail 1000 XT", submodel: "Limited Edition",
    stock_number: `ST-${1000 + i}`, created_at: "2026-11-02T13:00:00Z", expires_at: "2026-11-03T04:59:59Z",
    expired: false, time_zone: "America/New_York",
    rating: {
      state: STATES[i % 4], at: "2026-11-02T13:00:05Z",
      detail: STATES[i % 4] === "Failed" ? "Mock provider said no." : null,
      failures: STATES[i % 4] === "Failed" ? [{ provider: "Mock Provider", text: "Mock provider said no.", at: "2026-11-02T13:00:05Z" }] : [],
    },
  }));
}

const edge = http.createServer((req, res) => {
  const fn = new URL(req.url, "http://x").pathname.split("/").pop();
  const json = (b) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  // As fni-admin-sessions answers an Administrator (migration 0058): every
  // store, by full name, and the list by store, then most recent first.
  const stores = STORES.map((name, i) => ({ id: STORE_IDS[i], name }));
  if (fn === "fni-admin-sessions" && new URL(req.url, "http://x").searchParams.get("section") === "me") return json({ role: "Administrator", stores });
  if (fn === "fni-admin-sessions") {
    const list = sessions(rows).sort((a, b) => a.store_name.localeCompare(b.store_name));
    return json({ limit: 60, as_of: new Date().toISOString(), role: "Administrator", stores, notice: null, sessions: list });
  }
  if (fn === "fni-admin-settings") return json({ stores: STORES.map((name, i) => ({ id: `s${i}`, name })), rules: [], scope: "all" });
  res.writeHead(404); res.end("{}");
});
await new Promise((r) => edge.listen(EDGE_PORT, r));

const app = spawn("npx", ["next", "start", "-p", String(APP_PORT)], {
  cwd: APP,
  env: { ...process.env, FNI_WEBHOOK_SECRET: SECRET, SUPABASE_URL: `http://127.0.0.1:${EDGE_PORT}`, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: "ignore",
  detached: true,
});
for (let i = 0; i < 60; i++) {
  try { await fetch(`http://localhost:${APP_PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
}

const cookie = mintConsoleCookie({ sub: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a", email: "test.person@example.com" }, SECRET);
const browser = await chromium.launch();
let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.log(`  FAIL ${what}`); } };

async function nothingScrolls(p) {
  return p.evaluate(() => {
    const se = document.scrollingElement;
    const scroller = document.querySelector(".ad-scroll");
    const box = scroller.getBoundingClientRect();
    const shown = [...document.querySelectorAll("#ad-sessions tbody tr:not([hidden])")];
    const lastBottom = Math.max(0, ...shown.map((r) => r.getBoundingClientRect().bottom));
    return se.scrollHeight <= se.clientHeight && se.scrollWidth <= se.clientWidth &&
      scroller.scrollHeight <= scroller.clientHeight + 1 && lastBottom <= box.bottom + 1;
  });
}
const visibleDeals = (p) => p.$$eval("#ad-sessions tbody tr[data-row]:not([hidden]) td.ad-deal", (tds) => tds.map((t) => t.textContent.trim()));
const count = (p) => p.textContent("#ad-sessions-count");
const next = (p) => p.locator(".ad-pager button", { hasText: "Next" });

for (const n of [6, 60]) {
  rows = n;
  for (const [w, h] of [[1280, 800], [1366, 768], [1440, 900], [1920, 1080]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addCookies([{ name: "docuride_console", value: cookie, url: `http://localhost:${APP_PORT}` }]);
    const p = await ctx.newPage();
    await p.goto(`http://localhost:${APP_PORT}/admin/sessions`, { waitUntil: "networkidle" });

    // Every session, page by page, each once, and nothing scrolls on any page.
    const seen = [];
    let pages = 0;
    for (;;) {
      pages++;
      check(await nothingScrolls(p), `${w}x${h} ${n} sessions: page ${pages} scrolls`);
      seen.push(...(await visibleDeals(p)));
      if ((await next(p).count()) === 0 || (await next(p).isDisabled())) break;
      await next(p).click();
      if (pages > n) break;
    }
    const all = sessions(n).map((s) => s.deal_number);
    check(seen.length === n && new Set(seen).size === n && all.every((d) => seen.includes(d)),
      `${w}x${h} ${n} sessions: reached ${new Set(seen).size} of ${n}`);
    const paged = (await p.locator(".ad-pager").count()) > 0;
    check(paged === pages > 1, `${w}x${h} ${n} sessions: paging controls ${paged ? "shown" : "hidden"} with ${pages} page(s)`);

    // A filter applies before paging and goes back to page 1.
    if (pages > 1) {
      await p.goto(`http://localhost:${APP_PORT}/admin/sessions`, { waitUntil: "networkidle" });
      await next(p).click();
      // The store choice, at the top right since 8 Nov.
      await p.selectOption("#ad-top-tools select", STORE_IDS[1]);
      const firstMatch = sessions(n).filter((s) => s.store_name === STORES[1])[0].deal_number;
      const deals = await visibleDeals(p);
      check(deals[0] === firstMatch, `${w}x${h} ${n}: filter did not go back to page 1 (first ${deals[0]})`);
      check(deals.every((d) => sessions(n).find((s) => s.deal_number === d).store_name === STORES[1]), `${w}x${h} ${n}: filter not applied`);
      check(await nothingScrolls(p), `${w}x${h} ${n}: filtered page scrolls`);
      const c = await count(p);
      check(/^(1 to \d+ of \d+ sessions, from \d+|\d+ of \d+ sessions)\. Most recent first$/.test(c), `${w}x${h} ${n}: count "${c}"`);
      await p.selectOption("#ad-top-tools select", "");
      const byStore = sessions(n).sort((a, b) => a.store_name.localeCompare(b.store_name)).map((s) => s.deal_number);
      check((await visibleDeals(p))[0] === byStore[0], `${w}x${h} ${n}: clearing the filter did not go back to page 1`);
    }
    console.log(`${w}x${h} ${String(n).padStart(2)} sessions: ${pages} page(s), ${new Set(seen).size} reached, count "${await count(p)}"`);
    await ctx.close();
  }
}

await browser.close();
try { process.kill(-app.pid, "SIGTERM"); } catch { /* already gone */ }
edge.close();
console.log(failed === 0 ? "All checks passed." : `${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
