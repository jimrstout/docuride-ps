// test/docuride-switcher.test.mjs
//
// The app switcher (public/docuride-switcher.js): it reads the shared DocuRide
// sign-in, shows only for two or more assigned apps, lists only those, and
// marks the app the page belongs to. The same file is in every DocuRide app
// repo, next to the same docuride-switcher.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const candidates = ["public/docuride-switcher.js", "docuride-switcher.js", "apps/ownership-planner/public/docuride-switcher.js"];
const path = candidates.find((p) => existsSync(new URL(`../${p}`, import.meta.url)));
const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Run as a page would, with a stand-in window that has no page: the parts load, nothing mounts.
function load() {
  const win = {};
  new Function("window", source)(win);
  return win.DocuRideSwitcher;
}

const KEY = "sb-fovccigwlcmmzfubpfny-auth-token";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
function cookieFor(session, chunk = 3500) {
  const data = b64(JSON.stringify(session));
  const parts = [];
  for (let i = 0; i * chunk < data.length; i++) parts.push(`${KEY}.${i}=${data.slice(i * chunk, (i + 1) * chunk)}`);
  return ["other=1", ...parts].join("; ");
}
const session = { access_token: "tok", refresh_token: "ref", expires_at: 2000000000, user: { id: "u1", email: "x@y.z" } };

test("reads the shared sign-in cookie, chunked or not", () => {
  const sw = load();
  assert.deepEqual({ ...sw.readSession(cookieFor(session)) }, { token: "tok", user: "u1", expiresAt: 2000000000 });
  assert.deepEqual({ ...sw.readSession(cookieFor(session, 60)) }, { token: "tok", user: "u1", expiresAt: 2000000000 });
});

test("signed out, or an unreadable cookie, is no session", () => {
  const sw = load();
  assert.equal(sw.readSession(""), null);
  assert.equal(sw.readSession("other=1"), null);
  assert.equal(sw.readSession(`${KEY}.0=@@@`), null);
  assert.equal(sw.readSession(cookieFor({ ...session, access_token: "" })), null);
  assert.equal(sw.readSession(cookieFor({ ...session, user: null })), null);
});

test("an expired token waits for the app to refresh it", () => {
  const sw = load();
  const s = sw.readSession(cookieFor(session));
  assert.equal(sw.tokenExpired(s, 1000 * 1000), false);
  assert.equal(sw.tokenExpired(s, (2000000000 - 10) * 1000), true);
});

test("shows only for two or more apps", () => {
  const sw = load();
  assert.equal(sw.shouldShow([]), false);
  assert.equal(sw.shouldShow([{ key: "DC" }]), false);
  assert.equal(sw.shouldShow([{ key: "DC" }, { key: "FX" }]), true);
});

test("keeps only DocuRide https addresses, once each, in the server's order", () => {
  const sw = load();
  const rows = [
    { key: "HQ", label: "DocuRide HQ", url: "https://hq.docuride.com/" },
    { key: "FX", label: "DocuRide FX", url: "https://fx.docuride.com/" },
    { key: "FX", label: "dup", url: "https://fx.docuride.com/" },
    { key: "BAD", label: "x", url: "javascript:alert(1)" },
    { key: "HTTP", label: "x", url: "http://dc.docuride.com/" },
    { key: "ELSE", label: "x", url: "https://evil.example/" },
    { key: "R&R Reporting", label: "", url: "https://rr.docuride.com/admin" },
    null,
  ];
  const apps = sw.cleanApps(rows, "fx.docuride.com").map((a) => ({ ...a }));
  assert.deepEqual(apps.map((a) => a.key), ["HQ", "FX", "R&R Reporting"]);
  assert.equal(apps[2].label, "R&R Reporting");
  assert.deepEqual(sw.cleanApps(null, "x"), []);
  // A preview or localhost copy of an app may link to itself.
  assert.equal(sw.cleanApps([{ key: "FX", label: "FX", url: "https://fx-preview.vercel.app/" }], "fx-preview.vercel.app").length, 1);
});

test("marks the app this page belongs to by its address", () => {
  const sw = load();
  const apps = [
    { key: "HQ", label: "DocuRide HQ", url: "https://hq.docuride.com/" },
    { key: "R&R Reporting", label: "R&R Reporting", url: "https://rr.docuride.com/admin" },
  ];
  assert.equal(sw.currentKey(apps, "rr.docuride.com"), "R&R Reporting");
  assert.equal(sw.currentKey(apps, "HQ.docuride.com"), "HQ");
  assert.equal(sw.currentKey(apps, "localhost"), null);
});

test("names and colors match the HQ launcher", () => {
  const sw = load();
  assert.equal(sw.shortName("DocuRide FX"), "FX");
  assert.equal(sw.shortName("R&R Reporting"), "R&R Reporting");
  assert.equal(sw.lookOf("FX").c1, "#f97316");
  assert.equal(sw.lookOf("PS").c1, "#10b981");
  assert.equal(sw.lookOf("MX").c1, "#0e9f8e");
  assert.equal(sw.lookOf("RT").c1, "#eab308");
  assert.equal(sw.lookOf("NEW").c1, "#4f5bf5");
  // Every app has its own icon.
  const icons = ["HQ", "DC", "FX", "PS", "R&R Reporting", "MX", "RT"].map((k) => sw.lookOf(k).icon.join("|"));
  assert.equal(new Set(icons).size, icons.length);
});

test("is the same file in every DocuRide app", () => {
  // Update this when docuride-hq public/docuride-switcher.js changes, and copy the file to every app.
  const hash = createHash("sha256").update(source).digest("hex");
  assert.equal(hash, readFileSync(new URL("./docuride-switcher.sha256", import.meta.url), "utf8").trim());
});
