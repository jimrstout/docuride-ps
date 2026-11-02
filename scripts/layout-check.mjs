// scripts/layout-check.mjs: Prepare presentation and Present menu fit the window.
//
// Seven rows and four columns, with the longest names the catalog has
// (scripts/ui-mock/layout-data.mjs), at each window size from 1280x800 to
// 1920x1080. For each screen and size it checks, in a real browser:
//
//   - nothing scrolls and nothing is cut off: the footer row ends inside the window
//   - the grid is at most 1280px wide and centred; the header bar is full width
//   - the row names' column is as wide as "Mechanical Protection" and no wider
//   - every card in a row is the same height, with no empty band above its text
//   - a long name ends in "..." and its full text is on hover (title)
//
// Run after `npx next build` in apps/ownership-planner. Mock data only; nothing
// reaches Supabase. Screenshots go to the scratch folder given as the first
// argument, or the working directory.

import { startMockEdge, LAYOUT_SESSION } from "./ui-mock/edge.mjs";
import { chromium, signedIn, startApp } from "./ui-mock/app.mjs";

const OUT = process.argv[2] ?? ".";
const SIZES = [[1280, 800], [1366, 800], [1440, 900], [1600, 900], [1920, 1080]];
const SCREENS = [
  { name: "prepare", path: `/prepare/${LAYOUT_SESSION}`, grid: ".pm-grid", root: ".pm", head: ".pm-head", row: ".pm-row:not(.pm-row--head):not(.pm-row--foot)", label: ".pm-label", cell: ".pm-cell", text: ".pm-plan, .pm-sub", foot: ".pm-row--foot" },
  { name: "menu", path: `/menu/${LAYOUT_SESSION}`, grid: ".mn-grid", root: ".mn", head: ".mn-head", row: ".mn-row:not(.mn-row--head):not(.mn-row--foot)", label: ".mn-label", cell: ".mn-cell", text: ".mn-cap, .mn-cell-price", foot: ".mn-row--foot" },
];

const edge = await startMockEdge({ port: 4711 });
const app = await startApp({ appPort: 4712, edgePort: 4711 });
const browser = await chromium.launch();
const problems = [];
try {
  for (const [width, height] of SIZES) {
    const ctx = await signedIn(browser, app.base, { width, height });
    const page = await ctx.newPage();
    for (const s of SCREENS) {
      await page.goto(app.base + s.path, { waitUntil: "networkidle" });
      await page.waitForSelector(s.grid);
      const m = await page.evaluate((s) => {
        const q = (sel) => document.querySelector(sel);
        const all = (sel) => [...document.querySelectorAll(sel)];
        const grid = q(s.grid).getBoundingClientRect();
        const head = q(s.head).getBoundingClientRect();
        // The lowest edge of anything in the footer row, not just the row's box.
        const footBottom = Math.max(...[q(s.foot), ...q(s.foot).querySelectorAll("*")].map((e) => e.getBoundingClientRect().bottom));
        const clipped = all(`${s.cell}, ${s.foot} > *`).filter((c) => c.offsetParent && c.scrollHeight > c.clientHeight + 1).length;
        const rows = all(s.row);
        // The width "Mechanical Protection" needs in the row name's own font.
        const label = q(s.label);
        const probe = document.createElement("span");
        probe.textContent = "Mechanical Protection";
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(rows[0].querySelector(s.label)).font}`;
        document.body.appendChild(probe);
        const needed = probe.getBoundingClientRect().width;
        probe.remove();
        const labelWidth = rows[0].querySelector(s.label).getBoundingClientRect().width;
        const heights = rows.map((r) => [...r.querySelectorAll(s.cell)].filter((c) => c.offsetParent).map((c) => Math.round(c.getBoundingClientRect().height)));
        const bands = rows.flatMap((r) => [...r.querySelectorAll(s.cell)].filter((c) => c.offsetParent).map((c) => {
          const first = c.firstElementChild;
          return first ? Math.round(first.getBoundingClientRect().top - c.getBoundingClientRect().top) : 0;
        }));
        const cut = all(s.text).filter((e) => e.scrollWidth > e.clientWidth + 1);
        return {
          rows: rows.length,
          cols: rows[0].querySelectorAll(s.cell).length,
          docScroll: document.documentElement.scrollHeight - innerHeight,
          footBottom: Math.round(footBottom), innerHeight, clipped,
          gridWidth: Math.round(grid.width), gridLeft: Math.round(grid.left), gridRight: Math.round(innerWidth - grid.right),
          headWidth: Math.round(head.width), innerWidth,
          labelWidth: Math.round(labelWidth), needed: Math.round(needed),
          rowHeights: heights.map((h) => [Math.min(...h), Math.max(...h)]),
          maxBand: Math.max(...bands),
          cut: cut.length, cutWithoutTitle: cut.filter((e) => !e.title && !e.closest("[title]")).length,
        };
      }, s);
      await page.screenshot({ path: `${OUT}/layout-${s.name}-${width}x${height}.png` });
      const fail = (why) => problems.push(`${s.name} ${width}x${height}: ${why}`);
      if (m.rows !== 7 || m.cols !== 4) fail(`expected 7 rows and 4 columns, found ${m.rows} and ${m.cols}`);
      if (m.docScroll > 0) fail(`the page scrolls by ${m.docScroll}px`);
      if (m.footBottom > m.innerHeight) fail(`the footer ends at ${m.footBottom}px, below the window's ${m.innerHeight}px`);
      if (m.clipped > 0) fail(`${m.clipped} cards are cut off at the bottom`);
      if (m.gridWidth > 1280) fail(`the grid is ${m.gridWidth}px wide`);
      if (Math.abs(m.gridLeft - m.gridRight) > 2) fail(`the grid is not centred (${m.gridLeft}px left, ${m.gridRight}px right)`);
      if (m.headWidth !== m.innerWidth) fail(`the header bar is ${m.headWidth}px, not the full ${m.innerWidth}px`);
      if (m.labelWidth < m.needed - 1 || m.labelWidth > m.needed + 2) fail(`the row names' column is ${m.labelWidth}px; "Mechanical Protection" needs ${m.needed}px`);
      for (const [i, [lo, hi]] of m.rowHeights.entries()) if (hi - lo > 1) fail(`row ${i + 1}'s cards are ${lo} to ${hi}px tall`);
      if (m.maxBand > 12) fail(`a card has ${m.maxBand}px above its text`);
      if (m.cutWithoutTitle > 0) fail(`${m.cutWithoutTitle} cut-off names have no full text on hover`);
      console.log(`${s.name} ${width}x${height}: footer ends ${m.footBottom}/${m.innerHeight}px, grid ${m.gridWidth}px, names column ${m.labelWidth}px (needs ${m.needed}), ` +
        `tallest row ${Math.max(...m.rowHeights.map(([, h]) => h))}px, band ${m.maxBand}px, ${m.cut} names cut with "..."`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  app.stop();
  edge.close();
}
if (problems.length > 0) {
  console.log("\nProblems:\n" + problems.map((p) => `  ${p}`).join("\n"));
  process.exit(1);
}
console.log("\nEvery size fits: no scrolling, nothing cut off.");
