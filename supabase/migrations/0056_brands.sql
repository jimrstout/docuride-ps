-- 0056_brands.sql
--
-- Brands: the make on a deal, as one known brand, and the spelling each
-- provider server accepts for it.
--
-- Probes on deal 15063 (fni.rate_probes, 2026-11-02): only "Can-Am" got the
-- full lineup; "CAN AM", "Can Am" and "BRP" silently lost GAP, Theft and every
-- Mechanical Protection plan. The CRM's make is whatever was typed, so PS
-- matches it to a known brand, asks staff when it cannot, and sends the
-- provider's own spelling. The CRM is never changed.
--
--   fni.brands          the brands staff choose from on Details, with other
--                       spellings that mean the same brand (aliases):
--                       "Yamaha Motor Corp., USA" is Yamaha.
--   fni.brand_groups    parent companies and their brands, with the vehicle
--                       types each brand covers. A parent name never maps by
--                       itself: it narrows Details' choice. A brand marked
--                       preferred for a vehicle type is pre-selected there
--                       (older systems code Indian motorcycles as Polaris), and
--                       staff must still confirm it. Kept here, not in code, so
--                       a change of ownership is an edit in Administration.
--   fni.provider_makes  the provider's own makes list (POST /ps/makes), per
--                       provider, server (Test or Live), dealer and vehicle
--                       type, in its spellings. Filled by rating.
--   fni.brand_spellings a spelling staff or a probe settled for a brand, per
--                       provider, server and vehicle type. Wins over the list.
--
-- Test (QA) and Live are kept apart throughout: a spelling proved on QA is not
-- assumed for live.
--
-- Seeds: the brands the stores sell (read from dc.deals, read only) and the
-- groupings Jim gave. Additive only: four new tables, nothing changed in any
-- existing one, nothing dropped.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ── Lock check ──────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'fni'
       and l.pid <> pg_backend_pid()
       and l.mode in ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
  ) then
    raise exception 'A conflicting lock is held on an fni table. Nothing was changed.';
  end if;
end $$;

create table if not exists fni.brands (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  name        text not null check (btrim(name) <> ''),
  aliases     text[] not null default '{}',
  active      boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  unique (tenant_id, name)
);

create table if not exists fni.brand_groups (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  parent_name   text not null check (btrim(parent_name) <> ''),
  brand_name    text not null check (btrim(brand_name) <> ''),
  vehicle_types text[] not null default '{}',
  preferred     boolean not null default false,
  note          text,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  unique (tenant_id, parent_name, brand_name)
);

create table if not exists fni.provider_makes (
  id           uuid primary key default gen_random_uuid(),
  provider_id  uuid not null,
  environment  text not null check (environment in ('Test', 'Live')),
  dealer_code  text not null,
  vtype        text not null,
  make         text not null,
  fetched_at   timestamptz not null default now(),
  unique (provider_id, environment, dealer_code, vtype, make)
);

create table if not exists fni.brand_spellings (
  id           uuid primary key default gen_random_uuid(),
  provider_id  uuid not null,
  environment  text not null check (environment in ('Test', 'Live')),
  vtype        text not null,
  brand_name   text not null,
  spelling     text not null check (btrim(spelling) <> ''),
  source       text not null check (source in ('Provider list', 'Probe', 'Staff')),
  note         text,
  checked_at   timestamptz not null default now(),
  updated_by   text,
  unique (provider_id, environment, vtype, brand_name)
);

alter table fni.brands enable row level security;
alter table fni.brand_groups enable row level security;
alter table fni.provider_makes enable row level security;
alter table fni.brand_spellings enable row level security;

-- ── Seeds, for the tenant the catalog belongs to ────────────────────────
do $$
declare
  t uuid := (select tenant_id from fni.product_catalog where store_id is null limit 1);
  brands_added int;
  groups_added int;
begin
  if t is null then
    raise exception 'No catalog tenant found to seed brands for. Nothing was changed.';
  end if;

  insert into fni.brands (tenant_id, name, aliases, updated_by)
  select t, b.name, b.aliases, 'claude'
    from (values
      ('Can-Am',          array[]::text[]),
      ('Sea-Doo',         array[]::text[]),
      ('Ski-Doo',         array[]::text[]),
      ('Lynx',            array[]::text[]),
      ('Polaris',         array[]::text[]),
      ('Indian',          array['Indian Motorcycle']),
      ('Slingshot',       array[]::text[]),
      ('Kawasaki',        array[]::text[]),
      ('Honda',           array[]::text[]),
      ('Yamaha',          array['Yamaha Motor Corp., USA', 'Yamaha Motor Corporation']),
      ('Suzuki',          array[]::text[]),
      ('Harley-Davidson', array[]::text[]),
      ('LiveWire',        array[]::text[]),
      ('KTM',             array[]::text[]),
      ('BMW',             array[]::text[]),
      ('Royal Enfield',   array[]::text[]),
      ('Arctic Cat',      array[]::text[]),
      ('CFMOTO',          array[]::text[])
    ) as b(name, aliases)
   where not exists (select 1 from fni.brands x where x.tenant_id = t and x.name = b.name);
  get diagnostics brands_added = row_count;

  insert into fni.brand_groups (tenant_id, parent_name, brand_name, vehicle_types, preferred, note, updated_by)
  select t, g.parent, g.brand, g.types, g.preferred, g.note, 'claude'
    from (values
      ('BRP', 'Can-Am',  array['ATV', 'UTV', 'On-Road Motorcycle'], false, 'Spyder and Ryker are Can-Am models.'),
      ('BRP', 'Sea-Doo', array['Personal Watercraft'], false, null),
      ('BRP', 'Ski-Doo', array['Snowmobile'], false, null),
      ('BRP', 'Lynx',    array['Snowmobile'], false, null),
      ('Polaris', 'Polaris',   array['ATV', 'UTV', 'Snowmobile', 'Off-Road Motorcycle'], false, null),
      ('Polaris', 'Slingshot', array['On-Road Motorcycle'], false, null),
      ('Polaris', 'Indian',    array['On-Road Motorcycle'], true,
        'Indian is no longer part of Polaris, but older systems may still code Indian units as Polaris.'),
      ('Harley-Davidson', 'Harley-Davidson', array['On-Road Motorcycle'], false, null),
      ('Harley-Davidson', 'LiveWire',        array['On-Road Motorcycle'], false, null)
    ) as g(parent, brand, types, preferred, note)
   where not exists (select 1 from fni.brand_groups x where x.tenant_id = t and x.parent_name = g.parent and x.brand_name = g.brand);
  get diagnostics groups_added = row_count;

  if (select count(*) from fni.brands where tenant_id = t) < 18
     or (select count(*) from fni.brand_groups where tenant_id = t) < 9 then
    raise exception 'Expected the brand and group seeds in place; added % brands and % groups. Nothing was changed.', brands_added, groups_added;
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261103100000',
  '0056_brands',
  array['Brands, parent-company groupings, the provider makes list and per-server spellings: fni.brands, brand_groups, provider_makes, brand_spellings, seeded. See supabase/migrations/0056_brands.sql.'],
  'claude'
);

commit;
