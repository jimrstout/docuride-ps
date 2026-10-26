// Multi-provider Part 3: menu templates.
//
// The seeded "All deals" template must reproduce today's menu: the same five
// decisions with the same tiers. Matching must pick the most specific template.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeOffer } from "../supabase/functions/_shared/planner-offers.ts";
import {
  chooseTemplate,
  resolveSlots,
  specificity,
  templateMatches,
} from "../supabase/functions/_shared/menu-templates.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const QUOTE = JSON.parse(src("./fixtures/tecassured-rate-utv-3-306.json"));
const RA = { id: "prov-ra", name: "Riders Advantage" };
const MIGRATION = src("../supabase/migrations/0023_menu_templates.sql");

const template = (over = {}) => ({
  id: "t", name: "t", store_ids: [], deal_types: [], vehicle_types: [], conditions: [],
  makes: [], priority: 0, active: true, updated_at: "2026-10-17T00:00:00Z", ...over,
});
const deal = { store_id: "pkb", deal_type: "Loan", vehicle_type: "UTV", condition: "New", make: "Can-Am" };

test("an empty list matches anything; every specified condition must match", () => {
  assert.ok(templateMatches(template(), deal));
  assert.ok(templateMatches(template({ makes: ["can-am"], conditions: ["New"] }), deal));
  assert.ok(!templateMatches(template({ makes: ["Polaris"] }), deal));
  assert.ok(!templateMatches(template({ conditions: ["Used"] }), deal));
  assert.ok(!templateMatches(template({ store_ids: ["chs"] }), deal));
  assert.ok(!templateMatches(template({ deal_types: ["Cash"] }), deal));
  assert.ok(!templateMatches(template({ vehicle_types: ["ATV"] }), deal));
  assert.equal(specificity(template({ makes: ["Can-Am"], store_ids: ["pkb"] })), 2);
});

test("the most specific wins, then priority, then the most recent", () => {
  const all = template({ id: "all", name: "All deals" });
  const make = template({ id: "make", makes: ["Can-Am"], priority: 9 });
  const twoConds = template({ id: "two", makes: ["Can-Am"], conditions: ["New"] });
  assert.equal(chooseTemplate([all, make, twoConds], deal).id, "two");

  const a = template({ id: "a", makes: ["Can-Am"], priority: 1 });
  const b = template({ id: "b", makes: ["Can-Am"], priority: 2 });
  assert.equal(chooseTemplate([a, b], deal).id, "b");

  const older = template({ id: "older", makes: ["Can-Am"], updated_at: "2026-10-01T00:00:00Z" });
  const newer = template({ id: "newer", makes: ["Can-Am"], updated_at: "2026-10-10T00:00:00Z" });
  assert.equal(chooseTemplate([older, newer], deal).id, "newer");

  assert.equal(chooseTemplate([template({ active: false })], deal), null);
  assert.equal(chooseTemplate([make, all], { ...deal, make: "Honda" }).id, "all");
});

/** The seeded slots, read out of the migration. */
function seededSlots() {
  const values = MIGRATION.slice(MIGRATION.indexOf("cross join (values"));
  return [...values.matchAll(/\((\d), '([^']+)',\s+'([^']+)',\s+array\[([^\]]+)\]\)/g)].map((m) => ({
    position: Number(m[1]),
    title: m[2],
    codes: m[4].split(",").map((c) => c.trim().replace(/'/g, "")),
  }));
}

test("All deals reproduces today's menu: the same five decisions, the same tiers", () => {
  const seeded = seededSlots();
  assert.deepEqual(seeded.map((s) => s.title), ["Maintenance", "Mechanical Protection", "Tire and Wheel", "Theft", "Battery"]);

  const families = normalizeOffer(QUOTE, RA);
  const catalog = new Map(seeded.flatMap((s) => s.codes).map((code) => [`cat-${code}`, { provider_id: "prov-ra", product_code: code }]));
  const slots = seeded.map((s) => ({
    id: `slot-${s.position}`, template_id: "all", position: s.position, title: s.title,
    category: s.title, mode: "Side by Side", product_ids: s.codes.map((c) => `cat-${c}`),
  }));
  const resolved = resolveSlots(slots, families, catalog);

  assert.ok(resolved.every((r) => !r.hidden));
  // Every offered tier is in exactly one slot, and every slot is one family.
  const shown = resolved.flatMap((r) => r.tiers.map((t) => t.tier.product_code)).sort();
  const offered = families.flatMap((f) => f.tiers.map((t) => t.product_code)).sort();
  assert.deepEqual(shown, offered);
  for (const r of resolved) {
    assert.equal(new Set(r.tiers.map((t) => t.family.family_code)).size, 1, `${r.title} mixes families`);
  }
  assert.deepEqual(resolved.map((r) => r.tiers[0].family.family_code), ["PPM", "VSA", "TAW", "THP", "BAT"]);
});

test("Best Match shows the first offered product; an empty slot is hidden and explained", () => {
  const families = normalizeOffer(QUOTE, RA);
  const catalog = new Map([
    ["brp", { provider_id: "prov-brp", product_code: "BRP-B3" }],
    ["care", { provider_id: "prov-ra", product_code: "16_3" }],
    ["sd", { provider_id: "prov-ra", product_code: "86_3" }],
  ]);
  const [best, empty] = resolveSlots(
    [
      { id: "s1", template_id: "t", position: 1, title: "Mechanical Protection", category: null, mode: "Best Match", product_ids: ["brp", "care", "sd"] },
      { id: "s2", template_id: "t", position: 2, title: "BRP only", category: null, mode: "Side by Side", product_ids: ["brp"] },
    ],
    families,
    catalog
  );
  assert.deepEqual(best.tiers.map((t) => t.tier.product_code), ["16_3"]);
  assert.equal(empty.hidden, true);
  assert.equal(empty.staff_note, "BRP only: none of its 1 products got an offer for this deal, so it is not shown.");
});

test("the migration is additive and seeds only TecAssured products", () => {
  assert.doesNotMatch(MIGRATION, /\bdrop\b/i);
  assert.match(MIGRATION, /join fni\.providers p on p\.id = c\.provider_id and p\.adapter = 'TecAssured'/);
  assert.match(MIGRATION, /c\.store_id is null/);
  assert.equal(seededSlots().flatMap((s) => s.codes).length, 11);
  assert.match(MIGRATION, /add column if not exists menu_template_id uuid references fni\.menu_templates\(id\)/);
});
