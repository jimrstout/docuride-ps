-- 0001_tenancy_and_zoho_mirror
--
-- Phase 1 of the Zoho -> Supabase migration (see MIGRATION_PATH.md §3, §6).
-- Creates tenancy (tenants/stores/profiles), the Zoho DocuRide mirror (deals),
-- the field-ownership table that gates web writes, and the sync plumbing.
-- Also backfills tenant_id onto the pre-existing rr_report_runs table.
--
-- This file is the record of the schema that is live on project
-- fovccigwlcmmzfubpfny. It is written to be re-runnable: every statement is
-- guarded, so applying it against the current database is a no-op.
--
-- Note: the tenant uuid is resolved by sub-select on tenants.slug rather than
-- captured with psql's \gset, so this runs under `supabase db push`, the
-- Supabase SQL editor, or any plain client.

-- ---------- helpers ----------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path to 'public'
as $$ begin new.updated_at = now(); return new; end $$;

-- ---------- tenancy ----------

create table if not exists public.tenants (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  crm_sync   text not null default 'zoho' check (crm_sync in ('zoho', 'none')),
  config     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.stores (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  name                text not null,
  -- Matches the Zoho DocuRide "Store_Location" picklist value verbatim.
  -- Unique so the sync worker can resolve a deal to a store by that string.
  zoho_store_location text unique,
  dms_type            text not null default 'dx1',
  dms_config          jsonb not null default '{}'::jsonb,
  address             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id),
  role       text not null default 'user' check (role in ('owner', 'admin', 'user')),
  store_ids  uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now()
);

-- Tenant of the calling user. SECURITY DEFINER so RLS on profiles does not
-- recurse when other tables' policies call it.
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$ select tenant_id from public.profiles where user_id = auth.uid() $$;

-- ---------- zoho mirror ----------

create table if not exists public.deals (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id),
  store_id           uuid references public.stores(id),

  -- Zoho identity. zoho_id is the upsert key for the sync worker.
  zoho_id            text not null unique,
  zoho_modified_time timestamptz,

  -- Promoted columns: the fields we filter, sort or report on.
  -- Everything else lives in the jsonb groups below or in raw.
  deal_number        text,
  store_location     text,
  deal_status        text,
  esign_status       text,
  titlework_status   text,
  archive_status     text,
  sale_class         text,
  sale_date          date,
  buyer_display_name text,
  buyer_last_name    text,
  cobuyer_display_name text,
  salesperson        text,
  stock_number       text,
  vin                text,
  unit_year          text,
  unit_make          text,
  unit_model         text,
  reynolds_documents text,

  -- Grouped jsonb (MIGRATION_PATH.md §3: promote to a column only when you
  -- need to index or constrain it).
  dealership         jsonb not null default '{}'::jsonb,  -- Dealership_*
  tila               jsonb not null default '{}'::jsonb,  -- TILA_*
  financials         jsonb not null default '{}'::jsonb,  -- Sold_1_*
  trades             jsonb not null default '[]'::jsonb,  -- Trade_1..3_*

  -- Verbatim Zoho record. "Off a penny" debugging becomes a diff.
  raw                jsonb not null default '{}'::jsonb,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists deals_tenant_id_sale_date_idx
  on public.deals (tenant_id, sale_date);
create index if not exists deals_tenant_id_deal_status_esign_status_idx
  on public.deals (tenant_id, deal_status, esign_status);
create index if not exists deals_store_id_idx
  on public.deals (store_id);
create index if not exists deals_raw_idx
  on public.deals using gin (raw jsonb_path_ops);

drop trigger if exists deals_touch on public.deals;
create trigger deals_touch
  before update on public.deals
  for each row execute function public.touch_updated_at();

-- ---------- field ownership ----------

-- Exactly one writer per Zoho field (CLAUDE.md). Default owner is Zoho:
-- a field absent from this table is NOT web-writable. /api/deals/:id will
-- only accept a PATCH for fields present here with owner = 'web'.
create table if not exists public.field_ownership (
  tenant_id  uuid not null references public.tenants(id),
  zoho_field text not null,
  owner      text not null check (owner in ('zoho', 'web')),
  primary key (tenant_id, zoho_field)
);

-- ---------- sync plumbing ----------

-- Webhook lands here and returns immediately. The cron worker drains it.
create table if not exists public.sync_queue (
  id           bigserial primary key,
  tenant_id    uuid not null references public.tenants(id),
  module       text not null,
  zoho_id      text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  attempts     integer not null default 0,
  last_error   text
);

-- Partial index: the worker only ever scans unprocessed rows.
create index if not exists sync_queue_processed_at_idx
  on public.sync_queue (processed_at) where processed_at is null;

-- Audit of every web -> Zoho write.
create table if not exists public.sync_outbound (
  id            bigserial primary key,
  deal_id       uuid not null references public.deals(id),
  zoho_id       text not null,
  payload       jsonb not null,
  pushed_at     timestamptz not null default now(),
  zoho_response jsonb
);

-- ---------- rr_report_runs: add tenancy ----------

alter table public.rr_report_runs
  add column if not exists tenant_id uuid references public.tenants(id);

-- ---------- seed: tenant #1 ----------

insert into public.tenants (slug, name, crm_sync)
values ('allseasons', 'All Seasons Powersports / Applied Group', 'zoho')
on conflict (slug) do nothing;

insert into public.stores (tenant_id, name, zoho_store_location) values
  ((select id from public.tenants where slug = 'allseasons'), 'Charleston',         'All Seasons Powersports, Charleston'),
  ((select id from public.tenants where slug = 'allseasons'), 'Huntington',         'All Seasons Powersports, Barboursville/Huntington'),
  ((select id from public.tenants where slug = 'allseasons'), 'New Martinsville',   'All Seasons Powersports, New Martinsville'),
  ((select id from public.tenants where slug = 'allseasons'), 'Parkersburg',        'All Seasons Powersports, Parkersburg'),
  ((select id from public.tenants where slug = 'allseasons'), 'Equipment NM',       'All Seasons Equipment, New Martinsville'),
  ((select id from public.tenants where slug = 'allseasons'), 'Equipment PKB',      'All Seasons Equipment, Parkersburg'),
  ((select id from public.tenants where slug = 'allseasons'), 'Bell Chevrolet',     'Bell Chevrolet'),
  ((select id from public.tenants where slug = 'allseasons'), 'Country Roads Ford', 'Country Roads Ford'),
  ((select id from public.tenants where slug = 'allseasons'), 'iRide',              'iRide')
on conflict (zoho_store_location) do nothing;

-- The one field the web owns in Phase 1.
insert into public.field_ownership (tenant_id, zoho_field, owner)
values ((select id from public.tenants where slug = 'allseasons'), 'Other_Stipulation', 'web')
on conflict (tenant_id, zoho_field) do nothing;

update public.rr_report_runs
   set tenant_id = (select id from public.tenants where slug = 'allseasons')
 where tenant_id is null;

-- ---------- row level security ----------
--
-- MIGRATION_PATH.md §6: RLS on every table, keyed on tenant_id.
-- Read-only for end users; all writes go through Vercel functions using the
-- service-role key, which bypasses RLS.
--
-- sync_queue and sync_outbound intentionally get RLS with NO policies:
-- deny-all to anon/authenticated, service-role only.

alter table public.tenants         enable row level security;
alter table public.stores          enable row level security;
alter table public.profiles        enable row level security;
alter table public.deals           enable row level security;
alter table public.field_ownership enable row level security;
alter table public.sync_queue      enable row level security;
alter table public.sync_outbound   enable row level security;

drop policy if exists tenant_read on public.tenants;
create policy tenant_read on public.tenants
  for select using (id = public.current_tenant_id());

drop policy if exists stores_read on public.stores;
create policy stores_read on public.stores
  for select using (tenant_id = public.current_tenant_id());

drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for select using (user_id = auth.uid());

drop policy if exists deals_read on public.deals;
create policy deals_read on public.deals
  for select using (tenant_id = public.current_tenant_id());

drop policy if exists ownership_read on public.field_ownership;
create policy ownership_read on public.field_ownership
  for select using (tenant_id = public.current_tenant_id());
