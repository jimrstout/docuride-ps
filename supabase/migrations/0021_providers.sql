-- 0021_providers.sql
--
-- Many F&I providers. See docs/multi-provider.md.
--
-- Until now there was one: Riders Advantage, rated and contracted through the
-- TecAssured API. This adds fni.providers and a provider_id wherever a product,
-- a rating, a selection, a contract product, a pricing rule or a store account
-- is named, and backfills every existing row to Riders Advantage, so nothing a
-- live deal sees changes.
--
-- Everything stored is human-readable: "Connected", "Price Sheet",
-- "Through API", "Recorded by Staff", "Mechanical Protection".

-- ── 1. Providers ──────────────────────────────────────────────────────────

create table if not exists fni.providers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id),
  name            text not null,
  kind            text not null,
  adapter         text,
  contract_method text not null,
  -- The vehicle makes whose OEM program this is. Empty for aftermarket.
  -- Matched case-insensitively by the code that reads it.
  makes           text[] not null default '{}',
  active          boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      text,

  constraint providers_kind_known check (kind in ('Connected', 'Price Sheet')),
  constraint providers_contract_method_known
    check (contract_method in ('Through API', 'Recorded by Staff')),
  -- A Connected provider names the adapter that talks to its API; a Price
  -- Sheet provider has no API and so no adapter.
  constraint providers_adapter_matches_kind check (
    (kind = 'Connected' and adapter in ('TecAssured'))
    or (kind = 'Price Sheet' and adapter is null)
  ),
  constraint providers_name_present check (btrim(name) <> '')
);

create unique index if not exists providers_tenant_name_key
  on fni.providers (tenant_id, lower(name));

comment on table fni.providers is
  'F&I providers. Connected ones are rated and contracted through an API '
  '(adapter); Price Sheet ones are rated from uploaded, published price sheets '
  'and their contracts are recorded by staff.';

alter table fni.providers enable row level security;
grant select, insert, update, delete on fni.providers to service_role;
revoke all on fni.providers from anon, authenticated;

-- The one tenant this deployment serves: the same rule as zohoTenantId().
insert into fni.providers (tenant_id, name, kind, adapter, contract_method, makes, updated_by)
select t.id, p.name, p.kind, p.adapter, p.contract_method, p.makes, 'Migration 0021'
from public.tenants t
cross join (values
  ('Riders Advantage',  'Connected',   'TecAssured', 'Through API',       array[]::text[]),
  ('BRP',               'Price Sheet', null,         'Recorded by Staff', array['Can-Am', 'Sea-Doo', 'Ski-Doo']),
  ('Kawasaki',          'Price Sheet', null,         'Recorded by Staff', array['Kawasaki']),
  ('Honda',             'Price Sheet', null,         'Recorded by Staff', array['Honda']),
  ('Indian Motorcycle', 'Price Sheet', null,         'Recorded by Staff', array['Indian', 'Indian Motorcycle']),
  ('Polaris ORV',       'Price Sheet', null,         'Recorded by Staff', array['Polaris'])
) as p(name, kind, adapter, contract_method, makes)
where t.crm_sync = 'zoho'
on conflict (tenant_id, lower(name)) do nothing;

-- ── 2. The product catalog ────────────────────────────────────────────────

alter table fni.product_catalog add column if not exists provider_id uuid references fni.providers(id);
alter table fni.product_catalog add column if not exists category text;

update fni.product_catalog c
set provider_id = p.id
from fni.providers p
where c.provider_id is null and p.tenant_id = c.tenant_id and p.name = 'Riders Advantage';

update fni.product_catalog set category = case product_code
  when '16_3'  then 'Mechanical Protection'
  when '86_3'  then 'Mechanical Protection'
  when '66_7'  then 'Maintenance'
  when '78_7'  then 'Maintenance'
  when '72_7'  then 'Maintenance'
  when '84_7'  then 'Maintenance'
  when '23_4'  then 'Tire and Wheel'
  when '24_5'  then 'Theft'
  when '25_5'  then 'Theft'
  when '755_6' then 'Battery'
  when '754_6' then 'Battery'
  -- The five Parkersburg demo rows from the planner seed.
  when 'VSC'   then 'Mechanical Protection'
  when 'PPM'   then 'Maintenance'
  when 'TW'    then 'Tire and Wheel'
  else 'Other'
end
where category is null;

alter table fni.product_catalog alter column provider_id set not null;
alter table fni.product_catalog alter column category set not null;
alter table fni.product_catalog alter column category set default 'Other';
alter table fni.product_catalog drop constraint if exists product_catalog_category_known;
alter table fni.product_catalog add constraint product_catalog_category_known check (category in (
  'Mechanical Protection', 'Maintenance', 'Tire and Wheel', 'Theft', 'Battery', 'Appearance', 'Other'
));

-- Two providers may use the same product code. A store may still carry its
-- own copy of a product, which is how the catalog already works.
drop index if exists fni.product_catalog_tenant_product_key;
drop index if exists fni.product_catalog_store_product_key;
create unique index if not exists product_catalog_tenant_provider_product_key
  on fni.product_catalog (tenant_id, provider_id, product_code) where store_id is null;
create unique index if not exists product_catalog_store_provider_product_key
  on fni.product_catalog (tenant_id, store_id, provider_id, product_code) where store_id is not null;

-- ── 3. Selections and contract products ──────────────────────────────────

alter table fni.selected_products add column if not exists provider_id uuid references fni.providers(id);
update fni.selected_products sp
set provider_id = p.id
from fni.sessions s, fni.providers p
where sp.provider_id is null and s.id = sp.session_id
  and p.tenant_id = s.tenant_id and p.name = 'Riders Advantage';
alter table fni.selected_products alter column provider_id set not null;
drop index if exists fni.selected_products_session_product_key;
create unique index if not exists selected_products_session_provider_product_key
  on fni.selected_products (session_id, provider_id, provider_product_id);

alter table fni.agreement_products add column if not exists provider_id uuid references fni.providers(id);
update fni.agreement_products ap
set provider_id = sp.provider_id
from fni.selected_products sp
where ap.provider_id is null and sp.id = ap.selected_product_id;
alter table fni.agreement_products alter column provider_id set not null;
drop index if exists fni.agreement_products_one_live_per_product;
create unique index if not exists agreement_products_one_live_per_product
  on fni.agreement_products (agreement_id, provider_id, provider_product_id)
  where status in ('Live', 'Submit Status Unknown');

-- ── 4. Pricing rules ──────────────────────────────────────────────────────
-- Null means any provider, which is what every existing rule means.

alter table fni.pricing_rules add column if not exists provider_id uuid references fni.providers(id);

-- ── 5. Rated offers: one attempt per provider ────────────────────────────

alter table fni.rated_offers add column if not exists provider_id uuid references fni.providers(id);
update fni.rated_offers r
set provider_id = p.id
from fni.sessions s, fni.providers p
where r.provider_id is null and s.id = r.session_id
  and p.tenant_id = s.tenant_id and p.name = 'Riders Advantage';
alter table fni.rated_offers alter column provider_id set not null;
alter table fni.rated_offers drop constraint if exists rated_offers_session_id_key;
alter table fni.rated_offers drop constraint if exists rated_offers_session_provider_key;
alter table fni.rated_offers add constraint rated_offers_session_provider_key unique (session_id, provider_id);

-- ── 6. Store accounts ─────────────────────────────────────────────────────
-- A Price Sheet provider has no dealer code and no API credentials.

alter table fni.store_provider_accounts add column if not exists provider_id uuid references fni.providers(id);
update fni.store_provider_accounts a
set provider_id = p.id
from public.stores st, fni.providers p
where a.provider_id is null and st.id = a.store_id
  and p.tenant_id = st.tenant_id and p.name = 'Riders Advantage'
  and a.provider = 'TecAssured';
alter table fni.store_provider_accounts alter column provider_id set not null;
alter table fni.store_provider_accounts alter column dealer_code drop not null;
alter table fni.store_provider_accounts alter column credential_id drop not null;
alter table fni.store_provider_accounts drop constraint if exists store_provider_accounts_credential_provider_fkey;
drop index if exists fni.store_provider_accounts_one_active;
alter table fni.store_provider_accounts drop column if exists provider;
create unique index if not exists store_provider_accounts_one_active
  on fni.store_provider_accounts (store_id, provider_id) where active;

comment on column fni.store_provider_accounts.provider_id is
  'Which provider this store account is for. A Connected provider needs a '
  'dealer_code and credential_id; a Price Sheet provider has neither.';

-- ── 7. The presentable view carries the provider and category ─────────────
-- Recreated with the same columns in the same order, and the two new ones at
-- the end, which is all "create or replace view" allows.

create or replace view fni.product_catalog_presentable
  with (security_invoker = true) as
  select id, tenant_id, store_id, product_code, display_name, goal,
         what_it_accomplishes, what_it_covers, coverage_duration,
         what_it_excludes, deductible_note, how_to_use, transferable,
         transfer_note, future_value_note, full_terms_url, relevance_tags,
         display_order, active, created_at, updated_at,
         ( active
           and coalesce(btrim(what_it_accomplishes), '') <> ''
           and coalesce(btrim(what_it_covers),       '') <> ''
           and coalesce(btrim(coverage_duration),    '') <> ''
           and coalesce(btrim(what_it_excludes),     '') <> ''
           and coalesce(btrim(how_to_use),           '') <> ''
           and transferable is not null
           and coalesce(btrim(full_terms_url),       '') <> ''
         ) as is_presentable,
         provider_id, category
  from fni.product_catalog;
