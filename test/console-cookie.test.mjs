// The internal console's sign-in cookie.
//
// This cookie is the whole of the console's access control: whoever presents a
// valid one is shown every recent session and may extend any of them. A mistake
// in here is not a rendering bug, it is an open door, so each way of forging one
// gets its own case.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONSOLE_TTL_SECONDS,
  mintConsoleCookie,
  verifyConsoleCookie,
} from "../apps/ownership-planner/lib/console-cookie.ts";

const SECRET = "a-webhook-secret-of-realistic-length-0123456789";
const OTHER = "a-different-secret-of-the-same-length-9876543210";
const WHO = { sub: "b777e2a7-abf6-4653-a938-e8d7b363f40e", email: "jim@example.com" };

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

test("a cookie it minted is a cookie it accepts", () => {
  const session = verifyConsoleCookie(mintConsoleCookie(WHO, SECRET, NOW), SECRET, NOW);
  assert.equal(session?.sub, WHO.sub);
  assert.equal(session?.email, WHO.email);
  assert.equal(session?.exp, Math.floor(NOW / 1000) + CONSOLE_TTL_SECONDS);
});

test("the secret is not in the cookie", () => {
  // HKDF is what makes this true: the signature is over a derived key, so the
  // cookie the browser holds carries no trace of FNI_WEBHOOK_SECRET.
  const cookie = mintConsoleCookie(WHO, SECRET, NOW);
  assert.equal(cookie.includes(SECRET), false);
  assert.equal(Buffer.from(cookie).toString("base64url").includes(SECRET), false);
});

test("a cookie signed with another secret is refused", () => {
  const forged = mintConsoleCookie(WHO, OTHER, NOW);
  assert.equal(verifyConsoleCookie(forged, SECRET, NOW), null);
});

test("rotating FNI_WEBHOOK_SECRET signs everyone out", () => {
  // The same fact from the operator's side, and the intended consequence of a
  // rotation rather than a surprise.
  const before = mintConsoleCookie(WHO, SECRET, NOW);
  assert.notEqual(verifyConsoleCookie(before, SECRET, NOW), null);
  assert.equal(verifyConsoleCookie(before, OTHER, NOW), null);
});

test("an edited payload no longer matches its signature", () => {
  const [version, encoded, sig] = mintConsoleCookie(WHO, SECRET, NOW).split(".");
  const claim = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));

  // The two edits worth making: become someone else, and never expire.
  for (const patch of [{ sub: "someone-else" }, { exp: 4102444800 }]) {
    const tampered = Buffer.from(JSON.stringify({ ...claim, ...patch }), "utf8")
      .toString("base64url");
    assert.equal(verifyConsoleCookie(`${version}.${tampered}.${sig}`, SECRET, NOW), null);
  }
});

test("an unsigned cookie is refused, however well-formed", () => {
  const claim = Buffer.from(
    JSON.stringify({ ...WHO, exp: Math.floor(NOW / 1000) + 600 }),
    "utf8"
  ).toString("base64url");

  assert.equal(verifyConsoleCookie(`v1.${claim}.`, SECRET, NOW), null);
  assert.equal(verifyConsoleCookie(`v1.${claim}`, SECRET, NOW), null);
  assert.equal(verifyConsoleCookie(claim, SECRET, NOW), null);
});

test("a cookie expires on its own, without the browser's help", () => {
  const cookie = mintConsoleCookie(WHO, SECRET, NOW);
  const lifetime = CONSOLE_TTL_SECONDS * 1000;

  assert.notEqual(verifyConsoleCookie(cookie, SECRET, NOW + lifetime - 1000), null);
  assert.equal(verifyConsoleCookie(cookie, SECRET, NOW + lifetime + 1000), null);
});

test("nothing at all is refused rather than thrown at", () => {
  for (const value of [undefined, "", "v1", "v1..", "garbage", "v2.a.b", "a.b.c"]) {
    assert.equal(verifyConsoleCookie(value, SECRET, NOW), null);
  }
});
