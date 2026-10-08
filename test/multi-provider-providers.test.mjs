// Multi-provider, Part 1: providers in the data model.
//
// fni.providers exists, every table that names a product, a rating, a
// selection, a contract product, a pricing rule or a store account carries a
// provider, and every existing row is backfilled to Riders Advantage, so a
// deal at Parkersburg rates and presents exactly as before. See
// docs/multi-provider.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  CATEGORIES,
  CONTRACT_METHODS,
  PROVIDER_KINDS,
  isCategory,
  makeMatches,
  normalizeMake,
} from "../supabase/functions/_shared/providers.ts";
import { priceProduct, resolveRule } from "../supabase/functions/_shared/planner-pricing.ts";
import { normalizeOffer } from "../supabase/functions/_shared/planner-offers.ts";
import { customerPriceFor, priceFamilies } from "../supabase/functions/_shared/plan-prices.ts";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const sql = read("supabase/migrations/0021_providers.sql");
const fixture = JSON.parse(read("test/fixtures/tecassured-rate-utv-3-306.json"));

const RA = "prov-riders-advantage";
const BRP = "prov-brp";

// ── The seed ────────────────────────────────────────────────────────────

test("the six providers are seeded as specified, in plain words", () => {
  const seed = sql.slice(sql.indexOf("cross join (values"), sql.indexOf(") as p(name"));
  for (const line of [
    "('Riders Advantage',  'Connected',   'TecAssured', 'Through API',       array[]::text[])",
    "('BRP',               'Price Sheet', null,         'Recorded by Staff', array['Can-Am', 'Sea-Doo', 'Ski-Doo'])",
    "('Kawasaki',          'Price Sheet', null,         'Recorded by Staff', array['Kawasaki'])",
    "('Honda',             'Price Sheet', null,         'Recorded by Staff', array['Honda'])",
    "('Indian Motorcycle', 'Price Sheet', null,         'Recorded by Staff', array['Indian', 'Indian Motorcycle'])",
    "('Polaris ORV',       'Price Sheet', null,         'Recorded by Staff', array['Polaris'])",
  ]) {
    assert.ok(seed.includes(line), line);
  }
  // For the one tenant, and safe to run twice.
  assert.match(sql, /where t\.crm_sync = 'zoho'\s+on conflict \(tenant_id, lower\(name\)\) do nothing;/);
  // The stored words are the human ones.
  assert.match(sql, /check \(kind in \('Connected', 'Price Sheet'\)\)/);
  assert.match(sql, /check \(contract_method in \('Through API', 'Recorded by Staff'\)\)/);
  assert.deepEqual([...PROVIDER_KINDS], ["Connected", "Price Sheet"]);
  assert.deepEqual([...CONTRACT_METHODS], ["Through API", "Recorded by Staff"]);
  // A Connected provider names its adapter; a Price Sheet provider has none.
  assert.match(sql, /\(kind = 'Connected' and adapter in \('TecAssured'\)\)\s+or \(kind = 'Price Sheet' and adapter is null\)/);
});

test("makes match whatever their case or spacing, and aftermarket matches none", () => {
  assert.equal(makeMatches(["Can-Am", "Sea-Doo", "Ski-Doo"], "CAN-AM"), true);
  assert.equal(makeMatches(["Can-Am"], "  can-am "), true);
  assert.equal(makeMatches(["Indian", "Indian Motorcycle"], "indian  motorcycle"), true);
  assert.equal(makeMatches(["Polaris"], "Polaris Slingshot"), false);
  assert.equal(makeMatches([], "Honda"), false);
  assert.equal(makeMatches(["Honda"], ""), false);
  assert.equal(makeMatches(["Honda"], null), false);
  assert.equal(normalizeMake("  Sea-Doo  "), "sea-doo");
});

// ── The backfill ────────────────────────────────────────────────────────

test("every existing row is backfilled to Riders Advantage and then required", () => {
  for (const table of ["product_catalog", "selected_products", "rated_offers", "store_provider_accounts"]) {
    const block = sql.slice(sql.indexOf(`update fni.${table}`), sql.indexOf(`alter table fni.${table} alter column provider_id set not null`));
    assert.match(block, /p\.name = 'Riders Advantage'/, table);
    assert.match(sql, new RegExp(`alter table fni\\.${table} alter column provider_id set not null;`), table);
  }
  // A contract product takes the provider of the selection it was written for.
  assert.match(sql, /update fni\.agreement_products ap\s+set provider_id = sp\.provider_id\s+from fni\.selected_products sp/);
  assert.match(sql, /alter table fni\.agreement_products alter column provider_id set not null;/);
  // Pricing rules stay provider-less, which means any provider: what every
  // existing rule already meant.
  assert.match(sql, /alter table fni\.pricing_rules add column if not exists provider_id uuid references fni\.providers\(id\);/);
  assert.doesNotMatch(sql, /pricing_rules alter column provider_id set not null/);
});

test("the eleven TecAssured products get the specified categories", () => {
  const want = {
    "16_3": "Mechanical Protection", "86_3": "Mechanical Protection",
    "66_7": "Maintenance", "78_7": "Maintenance", "72_7": "Maintenance", "84_7": "Maintenance",
    "23_4": "Tire and Wheel", "24_5": "Theft", "25_5": "Theft",
    "755_6": "Battery", "754_6": "Battery",
  };
  for (const [code, category] of Object.entries(want)) {
    assert.match(sql, new RegExp(`when '${code}'\\s+then '${category}'`), code);
    assert.ok(isCategory(category));
  }
  assert.deepEqual([...CATEGORIES], [
    "Mechanical Protection", "Maintenance", "Tire and Wheel", "Theft", "Battery", "Appearance", "Other",
  ]);
  assert.match(sql, /product_catalog_category_known check \(category in \(\s*'Mechanical Protection', 'Maintenance', 'Tire and Wheel', 'Theft', 'Battery', 'Appearance', 'Other'\s*\)\)/);
});

test("uniqueness gains the provider everywhere a product is named", () => {
  assert.match(sql, /product_catalog_tenant_provider_product_key\s+on fni\.product_catalog \(tenant_id, provider_id, product_code\) where store_id is null;/);
  assert.match(sql, /selected_products_session_provider_product_key\s+on fni\.selected_products \(session_id, provider_id, provider_product_id\);/);
  assert.match(sql, /on fni\.agreement_products \(agreement_id, provider_id, provider_product_id\)\s+where status in \('Live', 'Submit Status Unknown'\);/);
  // One rating attempt per provider, not one per session.
  assert.match(sql, /drop constraint if exists rated_offers_session_id_key;/);
  assert.match(sql, /add constraint rated_offers_session_provider_key unique \(session_id, provider_id\);/);
});

test("a Price Sheet provider's store account needs no dealer code or login", () => {
  assert.match(sql, /store_provider_accounts alter column dealer_code drop not null;/);
  assert.match(sql, /store_provider_accounts alter column credential_id drop not null;/);
  assert.match(sql, /store_provider_accounts drop column if exists provider;/);
  assert.match(sql, /store_provider_accounts_one_active\s+on fni\.store_provider_accounts \(store_id, provider_id\) where active;/);
  // The presentable view carries the provider and category to the planner.
  assert.match(sql, /\) as is_presentable,\s+provider_id, category\s+from fni\.product_catalog;/);
});

// ── Pricing precedence ──────────────────────────────────────────────────

const rule = (over) => ({
  id: "r", tenant_id: "t", store_id: null, product_code: null, provider_id: null,
  cost_floor: 0, cost_ceiling: 5000, markup_percent: 100, markup_max_dollars: null,
  markup_min_dollars: 0, round_to: 5, active: true, ...over,
});

test("a provider's own rule beats a rule for any provider, before store and product", () => {
  const rules = [
    rule({ id: "any-store-product", store_id: "pkb", product_code: "16_3" }),
    rule({ id: "ra-tenant-catchall", provider_id: RA }),
  ];
  // The provider dimension comes first, so even a tenant-wide catch-all for
  // this provider beats a store and product rule for any provider.
  assert.equal(resolveRule(rules, "16_3", 500, RA).id, "ra-tenant-catchall");
  // Another provider's product falls through to the any-provider rule.
  assert.equal(resolveRule(rules, "16_3", 500, BRP).id, "any-store-product");
});

test("a rule for a different provider never applies", () => {
  const rules = [rule({ id: "brp-only", provider_id: BRP })];
  assert.equal(resolveRule(rules, "16_3", 500, RA), null);
  assert.equal(resolveRule(rules, "16_3", 500), null);
  assert.equal(priceProduct(rules, "16_3", 500, RA).unpriced_reason !== null, true);
});

test("with no provider rules, every price is what it was before providers", () => {
  // Parkersburg's three live rules, all written before 0021.
  const pkb = [
    rule({ id: "p1", store_id: "pkb", cost_floor: 0, cost_ceiling: 400, markup_percent: 250, markup_min_dollars: 75, markup_max_dollars: 600 }),
    rule({ id: "p2", store_id: "pkb", cost_floor: 400, cost_ceiling: 900, markup_percent: 120, markup_max_dollars: 800 }),
    rule({ id: "p3", store_id: "pkb", cost_floor: 900, cost_ceiling: 5000, markup_percent: 65, markup_max_dollars: 900 }),
  ].map(({ provider_id, ...r }) => r); // exactly as stored: no provider_id at all
  for (const cost of [20, 100, 300, 399.99, 400, 600, 1200, 2500, 4999]) {
    const before = priceProduct(pkb, "16_3", cost);
    const after = priceProduct(pkb, "16_3", cost, RA);
    assert.deepEqual(after, before, String(cost));
  }
});

// ── Offers and selections carry the provider ───────────────────────────

test("families read from a quote carry the provider they came from", () => {
  const families = normalizeOffer(fixture, { id: RA, name: "Riders Advantage" });
  assert.ok(families.length > 0);
  for (const f of families) {
    assert.equal(f.provider_id, RA);
    assert.equal(f.provider_name, "Riders Advantage");
  }
  // And without a provider, as a family built before 0021 would be.
  assert.equal(normalizeOffer(fixture)[0].provider_id, null);
});

test("a selection is priced against its own provider's product", () => {
  const priced = priceFamilies(normalizeOffer(fixture, { id: RA, name: "Riders Advantage" }), [rule({})]);
  const tier = priced[0].tiers[0];
  const rate = tier.rates[0];
  assert.equal(customerPriceFor(priced, tier.product_code, rate.rate_unique_id, [], RA), rate.retail_price);
  // The same code from another provider is not this product.
  assert.equal(customerPriceFor(priced, tier.product_code, rate.rate_unique_id, [], BRP), null);
});

test("every write names its provider and every upsert key includes it", () => {
  const save = read("supabase/functions/fni-session-save/index.ts");
  assert.match(save, /provider_id: providerOf\(d\),/);
  assert.match(save, /onConflict: "session_id,provider_id,provider_product_id"/);
  const submit = read("supabase/functions/fni-contract-submit/index.ts");
  assert.match(submit, /onConflict: "session_id,provider_id,provider_product_id"/);
  assert.equal((submit.match(/provider_id: store\.providerId,/g) ?? []).length, 2);
  const rate = read("supabase/functions/fni-rate-vehicle/index.ts");
  assert.match(rate, /provider_id: providerId,/);
  assert.match(rate, /onConflict: "session_id,provider_id"/);
  // The planner sends the provider with every decision.
  assert.match(read("apps/ownership-planner/app/plan/[sessionId]/Planner.tsx"), /provider_id: p\.provider_id,/);
  // A stored quote is read per provider, on the server.
  assert.match(read("supabase/functions/_shared/provider-rows.ts"), /\.from\("rated_offers"\)\s*\.select\(`\*, \$\{PROVIDER_EMBED\}`\)/);
});

test("no code finds a store's account by the old provider text", () => {
  const dir = new URL("../supabase/functions/", import.meta.url);
  const files = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".ts"));
  for (const f of files) {
    const text = readFileSync(new URL(String(f), dir), "utf8");
    assert.doesNotMatch(text, /\.eq\("provider", "TecAssured"\)/, String(f));
  }
  // TecAssured is found by its adapter, so renaming the provider cannot break it.
  assert.match(read("supabase/functions/_shared/provider-rows.ts"), /\.eq\("provider\.adapter", "TecAssured"\)/);
});
