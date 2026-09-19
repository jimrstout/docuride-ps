// The acknowledgment joins the existing signing pipeline through
// FNI_Signature_Map, which is a Zoho textarea with a hard 2000-character cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNATURE_MAP_LIMIT,
  appendSignatureMap,
  signatureLine,
  toTopLeft,
} from "../supabase/functions/_shared/signature-map.ts";

const LINE = "FNI_ACK_44e41c35.pdf|2|54|648|284|682|buyer";

test("builds the format fni-contract-documents already produces", () => {
  assert.equal(
    signatureLine({
      filename: "FNI_ACK_44e41c35.pdf",
      page: 2,
      left: 54,
      top: 647.6,
      right: 284,
      bottom: 681.8,
    }),
    LINE
  );
});

test("appends to an existing map without disturbing the lines already there", () => {
  const existing = "FNI_VSC_A1.pdf|1|72|500|300|540|buyer";
  const r = appendSignatureMap(existing, LINE);
  assert.ok(r.ok);
  assert.equal(r.value, `${existing}\n${LINE}`);
  assert.equal(r.value.split("\n").length, 2);
});

test("an empty map takes the first line cleanly", () => {
  for (const empty of [null, undefined, "", "   \n  "]) {
    assert.equal(appendSignatureMap(empty, LINE).value, LINE);
  }
});

test("a retry does not stack a second field on top of the first", () => {
  const once = appendSignatureMap("", LINE).value;
  const twice = appendSignatureMap(once, LINE);
  assert.ok(twice.ok);
  assert.equal(twice.value, once);
});

test("refuses to append past the field limit rather than truncating", () => {
  const nearlyFull = "x".repeat(SIGNATURE_MAP_LIMIT - 10);
  const r = appendSignatureMap(nearlyFull, LINE);
  assert.equal(r.ok, false);
  assert.equal(r.value, nearlyFull, "the existing map must be left untouched");
  assert.match(r.reason, /over the 2000 limit/);
});

test("fills the field exactly to the limit without refusing", () => {
  const room = SIGNATURE_MAP_LIMIT - LINE.length - 1; // -1 for the newline
  const r = appendSignatureMap("y".repeat(room), LINE);
  assert.ok(r.ok);
  assert.equal(r.value.length, SIGNATURE_MAP_LIMIT);
});

test("flips pdf-lib's bottom-left origin to top-left", () => {
  // A 34pt box sitting 100pt up from the bottom of a 792pt page.
  const { top, bottom } = toTopLeft(792, 100, 34);
  assert.equal(top, 658);
  assert.equal(bottom, 692);
  assert.equal(bottom - top, 34, "the box keeps its height through the flip");
});
