// scripts/ui-mock/app.mjs: the built app, run against the mock Edge Functions.
//
// Starts `next start` for apps/ownership-planner (build it first) pointed at
// the mock, and hands back a signed-in browser context. The sign-in cookie is
// minted with a throwaway secret that only this local run knows.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mintConsoleCookie } from "../../apps/ownership-planner/lib/console-cookie.ts";

export const { chromium } = createRequire(import.meta.url)("playwright");
const SECRET = "mock-secret-for-a-local-check-only";
const APP = new URL("../../apps/ownership-planner/", import.meta.url).pathname;

export async function startApp({ appPort, edgePort }) {
  const child = spawn("npx", ["next", "start", "-p", String(appPort)], {
    cwd: APP,
    env: { ...process.env, FNI_WEBHOOK_SECRET: SECRET, SUPABASE_URL: `http://127.0.0.1:${edgePort}`, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
    // Its own process group, so stopping it stops the Next server under npx too.
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://localhost:${appPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  const stop = () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  };
  return { base: `http://localhost:${appPort}`, stop };
}

export async function signedIn(browser, base, viewport = { width: 1366, height: 768 }) {
  const ctx = await browser.newContext({ viewport });
  const cookie = mintConsoleCookie({ sub: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a", email: "test.person@example.com" }, SECRET);
  await ctx.addCookies([{ name: "docuride_console", value: cookie, url: base }]);
  return ctx;
}
