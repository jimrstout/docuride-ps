-- 0006_fni_ownership_planner.sql
-- Schema for the Ownership Planner (customer-facing F&I menu).
--
-- Everything here lives in the fni schema. Nothing in public is touched.
-- The public.ensure_rls event trigger does not fire for fni, so RLS is enabled
-- explicitly below and grants stay service_role only, matching the rest of fni.
--
-- Cross-schema FKs to public.tenants / public.stores follow the existing pattern
-- set by fni.sessions and fni.provider_credentials.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. fni.product_catalog
--
-- Standardized, plain-language product copy. The premise of the planner is that
-- the platform educates the customer rather than the presenter, which only works
-- if this copy exists. A product with gaps here is not presentable.
--
-- store_id NULL means tenant-wide copy; a store row overrides the tenant row for
-- the same product_code.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists fni.product_catalog (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id),
  store_id              uuid references public.stores(id),

  -- TecAssured product identifier. Matches selected_products.provider_product_id.
  product_code          text not null,

  display_name          text not null,

  -- One of the three ownership goals the planner is organized around.
  goal                  text not null check (goal in (
                          'Keep ownership manageable',
                          'Keep ownership enjoyable',
                          'Keep the asset valuable'
                        )),

  -- The eight questions. Every one of these must be answered for the product to
  -- be presentable; see fni.product_catalog_presentable below.
  what_it_accomplishes  text,
  what_it_covers        text,
  coverage_duration     text,
  what_it_excludes      text,
  deductible_note       text,
  how_to_use            text,
  transferable          boolean,
  transfer_note         text,
  future_value_note     text,
  full_terms_url        text,

  display_order         integer not null default 100,
  active                boolean not null default true,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table fni.product_catalog is
  'Customer-facing plain-language product copy, keyed by TecAssured product code. '
  'Content task, not an engineering one: copy must be reviewed against the '
  'provider''s approved language before go-live.';

comment on column fni.product_catalog.store_id is
  'NULL for tenant-wide copy. A store row overrides the tenant row for the same product_code.';

-- One row per product per store, and one tenant-wide row per product.
create unique index if not exists product_catalog_store_product_key
  on fni.product_catalog (tenant_id, store_id, product_code)
  where store_id is not null;

create unique index if not exists product_catalog_tenant_product_key
  on fni.product_catalog (tenant_id, product_code)
  where store_id is null;

-- A product is presentable only when the copy that answers the customer's
-- questions is actually written. Selling off a marketing tagline is the exact
-- behaviour the planner exists to eliminate, so this is computed, not trusted.
create or replace view fni.product_catalog_presentable
  with (security_invoker = true) as
  select *,
         (
           active
           and coalesce(btrim(what_it_accomplishes), '') <> ''
           and coalesce(btrim(what_it_covers),       '') <> ''
           and coalesce(btrim(coverage_duration),    '') <> ''
           and coalesce(btrim(what_it_excludes),     '') <> ''
           and coalesce(btrim(how_to_use),           '') <> ''
           and transferable is not null
           and coalesce(btrim(full_terms_url),       '') <> ''
         ) as is_presentable
  from fni.product_catalog;

comment on view fni.product_catalog_presentable is
  'product_catalog with is_presentable computed. deductible_note, transfer_note '
  'and future_value_note are genuinely optional and are not required.';


-- ─────────────────────────────────────────────────────────────────────────
-- 2. fni.pricing_rules
--
-- Cost-banded markup per store. Required before any self-guided session, because
-- there is no F&I manager present to set a price.
--
-- A flat percentage does not work: 250% on a $199 contract is defensible, the
-- same 250% on a $1,349 VSC is not. markup_max_dollars is the ceiling that stops
-- the percentage running away.
--
-- Resolution order: exact product_code for the store, then the store catch-all
-- band (product_code null), then the tenant default (store_id null).
-- Price = cost + least(cost * markup_percent, markup_max_dollars),
--         floored at markup_min_dollars, then rounded to round_to.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists fni.pricing_rules (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id),
  store_id             uuid references public.stores(id),

  -- NULL = catch-all band covering any product not named explicitly.
  product_code         text,

  cost_floor           numeric(12,2) not null,
  cost_ceiling         numeric(12,2) not null,

  markup_percent       numeric(8,3)  not null,
  markup_max_dollars   numeric(12,2),
  markup_min_dollars   numeric(12,2) not null default 0,

  -- e.g. 5 gives prices ending in 0 or 5. 0 or NULL disables rounding.
  round_to             numeric(8,2)  not null default 5,

  active               boolean not null default true,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint pricing_rules_band_ordered   check (cost_ceiling > cost_floor),
  constraint pricing_rules_floor_positive check (cost_floor >= 0),
  constraint pricing_rules_markup_sane    check (markup_percent >= 0),
  constraint pricing_rules_min_le_max     check (
    markup_max_dollars is null or markup_min_dollars <= markup_max_dollars
  )
);

comment on table fni.pricing_rules is
  'Cost-banded markup per store. Also the place to enforce state-level caps '
  'where they exist (GAP being the obvious case).';

create index if not exists pricing_rules_lookup
  on fni.pricing_rules (tenant_id, store_id, product_code, active);


-- ─────────────────────────────────────────────────────────────────────────
-- 3. fni.sessions additions
-- ─────────────────────────────────────────────────────────────────────────

-- Session expiry. The session UUID in the URL is the only credential protecting
-- buyer PII, and until now it never went stale — a link in the history of a
-- shared showroom tablet stayed live forever. fni-session-get returns 410 past
-- this; staff restart from Zoho in one click.
alter table fni.sessions
  add column if not exists expires_at timestamptz not null default (now() + interval '24 hours');

comment on column fni.sessions.expires_at is
  'Session hard expiry. fni-session-get returns 410 Gone once passed.';

-- Payment-math inputs that were missing. See SPEC_CORRECTIONS.md §1 — without
-- these the planner cannot reproduce the contract payment, and a planner that
-- quotes a payment no lender agreed to is worse than no planner.

-- Zoho Interest_Rate. Distinct from TILA_APR and genuinely different on real
-- deals (7.84 vs 8.5165 on the first live record). APR wins when present.
alter table fni.sessions
  add column if not exists interest_rate numeric(8,4);

comment on column fni.sessions.interest_rate is
  'Zoho Interest_Rate. The planner amortizes with apr when present and falls '
  'back to this, and labels the field honestly for whichever it used.';

-- Zoho TILA_Amount_Financed: the principal the lender actually amortizes.
-- amount_financed (DC_Sold_1_Balance_Due) is the balance due on the unit and is
-- a different, smaller number.
alter table fni.sessions
  add column if not exists tila_amount_financed numeric(12,2);

comment on column fni.sessions.tila_amount_financed is
  'Zoho TILA_Amount_Financed — the amortization principal. Differs from '
  'amount_financed, which is the balance due on the unit.';

-- Zoho Term_Months. finance_term maps from TILA_Pmt1_Count, which on a deal with
-- an odd final payment is the first payment stream's count (59), not the term (60).
alter table fni.sessions
  add column if not exists finance_term_total integer;

comment on column fni.sessions.finance_term_total is
  'True loan term (Zoho Term_Months = TILA_Pmt1_Count + TILA_Pmt2_Count). '
  'finance_term is the first payment stream count and is NOT the term.';

-- Discovery answers. Part of the audit trail: what the customer was asked and
-- what they said, alongside what they were shown.
alter table fni.sessions
  add column if not exists discovery jsonb;

-- Self-guided vs staff-presented. A presentation detail, not a separate build,
-- but the acknowledgment document has to state which one it was.
alter table fni.sessions
  add column if not exists mode text
    check (mode is null or mode in ('self-guided', 'collaborative', 'staff-presented'));

-- DX1 photo cache, so stepping back and forth through the planner does not
-- re-hit DX1 on every render.
alter table fni.sessions
  add column if not exists dx1_photos jsonb;

alter table fni.sessions
  add column if not exists dx1_photos_cached_at timestamptz;

comment on column fni.sessions.dx1_photos is
  'Cached DX1 image URLs by VIN. An empty array means "looked up, none exist" — '
  'which is a designed empty state, not a failure.';


-- ─────────────────────────────────────────────────────────────────────────
-- 4. fni.selected_products additions
--
-- Until now an unselected product was simply absent, so a product the customer
-- declined was indistinguishable from one they never reached. The acknowledgment
-- document has to list everything presented alongside what was decided, so
-- declines get a row too.
-- ─────────────────────────────────────────────────────────────────────────

alter table fni.selected_products
  add column if not exists disposition text;

update fni.selected_products set disposition = 'Included' where disposition is null;

alter table fni.selected_products
  alter column disposition set default 'Included',
  alter column disposition set not null;

-- Human-readable values, deliberately. These strings are what the customer signs,
-- so they are not enum-style tokens that need translating at the last moment.
alter table fni.selected_products
  drop constraint if exists selected_products_disposition_check;

alter table fni.selected_products
  add constraint selected_products_disposition_check
    check (disposition in ('Included', 'Managed by Customer'));

comment on column fni.selected_products.disposition is
  'Included | Managed by Customer. Written for declines as well as includes — '
  'a session where everything was declined is the one most worth having a record of.';

-- When the product was put in front of the customer, as distinct from when they
-- decided. The standardization premise depends on this being recorded.
alter table fni.selected_products
  add column if not exists presented_at timestamptz;

-- A decline still names a product, so the identity columns stay NOT NULL, but it
-- has no price and no rate snapshot.
alter table fni.selected_products alter column dealer_cost    drop not null;
alter table fni.selected_products alter column retail_price   drop not null;
alter table fni.selected_products alter column customer_price drop not null;
alter table fni.selected_products alter column rate_snapshot  drop not null;
alter table fni.selected_products alter column rate_unique_id drop not null;

-- The upsert key fni-session-save needs. Without this a repeated save inserts
-- duplicates instead of updating, and the customer's last answer does not win.
create unique index if not exists selected_products_session_product_key
  on fni.selected_products (session_id, provider_product_id);


-- ─────────────────────────────────────────────────────────────────────────
-- 5. Grants and RLS
--
-- Only service_role touches fni. anon and authenticated get nothing, which is
-- what forces every read and write through an Edge Function and keeps buyer PII
-- out of the browser's reach.
-- ─────────────────────────────────────────────────────────────────────────

alter table fni.product_catalog enable row level security;
alter table fni.pricing_rules   enable row level security;

grant select, insert, update, delete on fni.product_catalog to service_role;
grant select, insert, update, delete on fni.pricing_rules   to service_role;
grant select                        on fni.product_catalog_presentable to service_role;

revoke all on fni.product_catalog               from anon, authenticated;
revoke all on fni.pricing_rules                 from anon, authenticated;
revoke all on fni.product_catalog_presentable   from anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────
-- 6. Backfill the payment-math columns on sessions created before this change
--
-- raw_snapshot already holds the full Zoho record on every session, so the three
-- new values can be recovered rather than requiring a re-pull. Zoho sends these
-- as display strings ("13,930.94"), hence the comma stripping.
--
-- fni-session-get performs the same derivation and writes it back, so a session
-- created by an older deploy of fni-session-start heals itself on first load.
-- ─────────────────────────────────────────────────────────────────────────

update fni.sessions s
set interest_rate = nullif(replace(replace(s.raw_snapshot->>'Interest_Rate', ',', ''), '$', ''), '')::numeric,
    tila_amount_financed = nullif(replace(replace(s.raw_snapshot->>'TILA_Amount_Financed', ',', ''), '$', ''), '')::numeric,
    finance_term_total = coalesce(
      nullif(replace(s.raw_snapshot->>'Term_Months', ',', ''), '')::numeric,
      nullif(s.raw_snapshot->>'TILA_Pmt1_Count','')::numeric
        + coalesce(nullif(s.raw_snapshot->>'TILA_Pmt2_Count','')::numeric, 0)
    )::integer
where s.raw_snapshot is not null;
