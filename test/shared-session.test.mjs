// test/shared-session.test.mjs
//
// One sign-in for every DocuRide app: a session saved on one docuride.com
// subdomain must be readable on another, and signing out must clear it there.
// The same tests run against docuride-session.js here and
// app/lib/shared-session.ts in docuride-hq.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// docuride-session.js is a plain browser script: run it the way a page does.
const ctx = vm.createContext({ TextEncoder, TextDecoder, btoa, atob, Map, Uint8Array });
vm.runInContext(readFileSync(new URL("../docuride-session.js", import.meta.url), "utf8"), ctx);
const { createSharedSessionStorage, sharedDomain } = ctx.DocuRideSession;

// A tiny browser cookie store: cookies set with Domain=docuride.com are seen by
// every docuride.com host; cookies without a Domain stay on their own host.
function browser() {
  const cookies = new Map(); // "scope|name" -> value
  const set = [];
  return {
    set,
    tab(hostname) {
      return {
        get cookie() {
          const out = [];
          for (const [k, v] of cookies) {
            const [scope, name] = k.split("|");
            const shared = scope === "docuride.com" && (hostname === scope || hostname.endsWith("." + scope));
            if (shared || scope === hostname) out.push(`${name}=${v}`);
          }
          return out.join("; ");
        },
        set cookie(line) {
          set.push(line);
          const [pair, ...attrs] = line.split(";").map((s) => s.trim());
          const eq = pair.indexOf("=");
          const name = pair.slice(0, eq);
          const value = pair.slice(eq + 1);
          const domain = attrs.find((a) => a.startsWith("Domain="))?.slice(7) ?? hostname;
          if (attrs.includes("Max-Age=0")) cookies.delete(`${domain}|${name}`);
          else cookies.set(`${domain}|${name}`, value);
        },
      };
    },
  };
}

const KEY = "sb-fovccigwlcmmzfubpfny-auth-token";
const storageOn = (b, hostname, legacy = null) =>
  createSharedSessionStorage({ doc: b.tab(hostname), hostname, secure: true, legacy });

test("only docuride.com hosts share the cookie", () => {
  assert.equal(sharedDomain("hq.docuride.com"), "docuride.com");
  assert.equal(sharedDomain("fx.docuride.com"), "docuride.com");
  assert.equal(sharedDomain("docuride.com"), "docuride.com");
  assert.equal(sharedDomain("localhost"), null);
  assert.equal(sharedDomain("docuride-hq.vercel.app"), null);
  assert.equal(sharedDomain("notdocuride.com"), null);
});

test("signing in at HQ signs you in at FX", () => {
  const b = browser();
  const session = JSON.stringify({ access_token: "a".repeat(1200), refresh_token: "r", user: { email: "x@y.z", note: "ünïcödé ✓" } });
  storageOn(b, "hq.docuride.com").setItem(KEY, session);
  assert.equal(storageOn(b, "fx.docuride.com").getItem(KEY), session);
});

test("a large session is split into cookies under the browser limit, and read back whole", () => {
  const b = browser();
  const session = JSON.stringify({ blob: "z".repeat(12000) });
  storageOn(b, "hq.docuride.com").setItem(KEY, session);
  assert.ok(b.set.length > 1);
  for (const line of b.set) assert.ok(line.length < 4000, "each cookie stays under 4 KB");
  assert.equal(storageOn(b, "fx.docuride.com").getItem(KEY), session);
});

test("a smaller session clears the leftover pieces of a larger one", () => {
  const b = browser();
  const hq = storageOn(b, "hq.docuride.com");
  hq.setItem(KEY, JSON.stringify({ blob: "z".repeat(12000) }));
  hq.setItem(KEY, '{"small":true}');
  assert.equal(storageOn(b, "fx.docuride.com").getItem(KEY), '{"small":true}');
  assert.ok(!b.tab("fx.docuride.com").cookie.includes(`${KEY}.1=`));
});

test("signing out at FX signs you out at HQ", () => {
  const b = browser();
  storageOn(b, "hq.docuride.com").setItem(KEY, '{"s":1}');
  storageOn(b, "fx.docuride.com").removeItem(KEY);
  assert.equal(storageOn(b, "hq.docuride.com").getItem(KEY), null);
});

test("cookies are Secure, Lax, and on docuride.com only when on docuride.com", () => {
  const b = browser();
  storageOn(b, "hq.docuride.com").setItem(KEY, "{}");
  assert.match(b.set[0], /Domain=docuride\.com/);
  assert.match(b.set[0], /Secure/);
  assert.match(b.set[0], /SameSite=Lax/);
  const local = browser();
  createSharedSessionStorage({ doc: local.tab("localhost"), hostname: "localhost", secure: false }).setItem(KEY, "{}");
  assert.doesNotMatch(local.set[0], /Domain=/);
  assert.doesNotMatch(local.set[0], /Secure/);
});

test("someone already signed in the old way stays signed in, and it moves to the shared cookie", () => {
  const b = browser();
  const old = new Map([[KEY, '{"old":true}']]);
  const legacy = { getItem: (k) => old.get(k) ?? null, removeItem: (k) => old.delete(k) };
  assert.equal(storageOn(b, "hq.docuride.com", legacy).getItem(KEY), '{"old":true}');
  assert.equal(old.has(KEY), false);
  assert.equal(storageOn(b, "fx.docuride.com").getItem(KEY), '{"old":true}');
});

test("a damaged cookie reads as signed out instead of crashing", () => {
  const b = browser();
  b.tab("fx.docuride.com").cookie = `${KEY}.0=%%%; Domain=docuride.com`;
  assert.equal(storageOn(b, "fx.docuride.com").getItem(KEY), null);
});
